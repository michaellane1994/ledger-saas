// Ledger SaaS — Cloudflare Worker
// Handles Stripe checkout, customer portal, and webhook routes.
// All other paths fall through to static assets in /public.

const STRIPE_API = 'https://api.stripe.com/v1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/create-checkout-session' && request.method === 'POST') {
      return handleCreateCheckout(request, env);
    }
    if (path === '/api/create-portal-session' && request.method === 'POST') {
      return handleCreatePortal(request, env);
    }
    if (path === '/api/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (path === '/api/me' && request.method === 'GET') {
      return handleMe(request, env);
    }
    if (path === '/api/diag' && request.method === 'GET') {
      return handleDiag(env);
    }

    return env.ASSETS.fetch(request);
  }
};

function handleDiag(env) {
  // Reports which env vars are SET (without leaking values).
  // Useful for verifying Cloudflare secret names match the code's expectations.
  const required = ['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
  const supaSecretNames = ['SUPABASE_SERVICE_ROLE','SUPABASE_SECRET_KEY'];
  const status = {};
  required.forEach(n => { status[n] = !!env[n]; });
  status['SUPABASE_SECRET (service_role OR secret_key)'] = supaSecretNames.some(n => !!env[n]);
  status._supaSecretFoundUnder = supaSecretNames.find(n => !!env[n]) || null;
  return json(status);
}

// ─── helpers ──────────────────────────────────────────────

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function getAuthedUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function supabaseAdmin(env, path, options = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      apikey: env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  });
}

async function fetchUserRow(env, userId) {
  const res = await supabaseAdmin(env, `/users?id=eq.${userId}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0];
}

async function fetchUserRowByCustomer(env, customerId) {
  const q = encodeURIComponent(customerId);
  const res = await supabaseAdmin(env, `/users?stripe_customer_id=eq.${q}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0];
}

async function updateUserRow(env, userId, patch) {
  const res = await supabaseAdmin(env, `/users?id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[updateUserRow] failed', res.status, body);
  }
  return res.ok;
}

// Encode an object as Stripe-style form data (a=1&b[c]=2)
function stripeFormData(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') {
          out.push(stripeFormData(item, `${key}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (typeof v === 'object') {
      out.push(stripeFormData(v, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return out.filter(Boolean).join('&');
}

async function stripeFetch(env, path, body = null, method = body ? 'POST' : 'GET') {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (body) init.body = stripeFormData(body);
  return fetch(`${STRIPE_API}${path}`, init);
}

// ─── handlers ─────────────────────────────────────────────

async function handleCreateCheckout(request, env) {
  const user = await getAuthedUser(request, env);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: 'Bad JSON' }, 400); }
  const { priceId } = payload;
  if (!priceId) return json({ error: 'priceId required' }, 400);

  const userRow = await fetchUserRow(env, user.id);
  let customerId = userRow?.stripe_customer_id;
  if (!customerId) {
    const cRes = await stripeFetch(env, '/customers', {
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    if (!cRes.ok) {
      const err = await cRes.text();
      return json({ error: 'Stripe customer create failed', details: err }, 500);
    }
    const cust = await cRes.json();
    customerId = cust.id;
    await updateUserRow(env, user.id, { stripe_customer_id: customerId });
  }

  const origin = new URL(request.url).origin;
  const sessRes = await stripeFetch(env, '/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/?subscribed=1`,
    cancel_url: `${origin}/?subscribed=0`,
    allow_promotion_codes: true,
  });
  if (!sessRes.ok) {
    const err = await sessRes.text();
    return json({ error: 'Stripe checkout create failed', details: err }, 500);
  }
  const session = await sessRes.json();
  return json({ url: session.url });
}

async function handleCreatePortal(request, env) {
  const user = await getAuthedUser(request, env);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const userRow = await fetchUserRow(env, user.id);
  if (!userRow?.stripe_customer_id) {
    return json({ error: 'No subscription on file' }, 400);
  }

  const origin = new URL(request.url).origin;
  const res = await stripeFetch(env, '/billing_portal/sessions', {
    customer: userRow.stripe_customer_id,
    return_url: `${origin}/`,
  });
  if (!res.ok) {
    const err = await res.text();
    return json({ error: 'Portal create failed', details: err }, 500);
  }
  const session = await res.json();
  return json({ url: session.url });
}

async function handleWebhook(request, env) {
  const sig = request.headers.get('Stripe-Signature') || '';
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'Invalid signature' }, 400);

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (!session.subscription) break;
        const sub = await fetchSubscription(env, session.subscription);
        if (sub) await applySubStatus(env, sub.customer, sub.status);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await applySubStatus(env, sub.customer, sub.status);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await applySubStatus(env, sub.customer, 'canceled');
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        await applySubStatus(env, inv.customer, 'past_due');
        break;
      }
    }
  } catch (e) {
    return json({ error: 'Webhook handler error: ' + e.message }, 500);
  }

  return json({ received: true });
}

async function handleMe(request, env) {
  const user = await getAuthedUser(request, env);
  if (!user) return json({ error: 'Not authenticated' }, 401);
  const userRow = await fetchUserRow(env, user.id);
  return json({ user: { id: user.id, email: user.email }, profile: userRow });
}

async function fetchSubscription(env, subscriptionId) {
  const res = await stripeFetch(env, `/subscriptions/${subscriptionId}`, null, 'GET');
  if (!res.ok) return null;
  return await res.json();
}

async function applySubStatus(env, customerId, stripeStatus) {
  const userRow = await fetchUserRowByCustomer(env, customerId);
  if (!userRow) {
    console.error('[applySubStatus] no user row for customer', customerId);
    return;
  }
  const ok = await updateUserRow(env, userRow.id, { subscription_status: mapStatus(stripeStatus) });
  if (!ok) console.error('[applySubStatus] update failed for', userRow.id);
}

function mapStatus(stripeStatus) {
  // Map Stripe statuses to our schema's allowed values:
  // trialing | active | canceled | past_due
  switch (stripeStatus) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'canceled': return 'canceled';
    case 'incomplete_expired': return 'canceled';
    case 'past_due': return 'past_due';
    case 'unpaid': return 'past_due';
    case 'incomplete': return 'past_due';
    default: return 'active';
  }
}

// ─── Stripe webhook signature ────────────────────────────

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const parts = signatureHeader.split(',').map(p => p.trim());
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Parts = parts.filter(p => p.startsWith('v1='));
  if (!tPart || v1Parts.length === 0) return false;
  const timestamp = tPart.slice(2);
  // Reject if timestamp is older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const sigHex = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  for (const v1 of v1Parts.map(p => p.slice(3))) {
    if (v1.length !== sigHex.length) continue;
    let mismatch = 0;
    for (let i = 0; i < v1.length; i++) {
      mismatch |= sigHex.charCodeAt(i) ^ v1.charCodeAt(i);
    }
    if (mismatch === 0) return true;
  }
  return false;
}
