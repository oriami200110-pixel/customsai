// api/webhook-lemon.js
// Receives Lemon Squeezy order_created webhooks and upgrades the user's plan to 'pro'
//
// Required Vercel env vars:
//   LEMON_SIGNING_SECRET  — from Lemon Squeezy Store → Webhooks
//   SUPABASE_URL          — https://wqkuliasszkgwllifinp.supabase.co
//   SUPABASE_SERVICE_KEY  — service_role key from Supabase → Settings → API

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 1. Verify Lemon Squeezy signature ──────────────────────────────────────
  const signingSecret = process.env.LEMON_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('LEMON_SIGNING_SECRET env var not set');
    return res.status(500).json({ error: 'Webhook signing secret not configured' });
  }

  const signature = req.headers['x-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing x-signature header' });
  }

  // Vercel auto-parses JSON bodies — re-stringify to verify signature
  const rawBody = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(rawBody)
    .digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) {
      console.error('Signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid signature format' });
  }

  // ── 2. Only handle order_created events ────────────────────────────────────
  const eventName = req.headers['x-event-name'];
  console.log(`Lemon Squeezy event: ${eventName}`);

  if (eventName !== 'order_created') {
    return res.status(200).json({ ok: true, ignored: true, event: eventName });
  }

  // ── 3. Extract buyer details from payload ──────────────────────────────────
  const attributes = req.body?.data?.attributes;
  const email      = attributes?.user_email;
  const orderId    = String(req.body?.data?.id ?? '');
  const customerId = String(attributes?.customer_id ?? '');
  const status     = attributes?.status; // 'paid' | 'refunded' | etc.

  if (!email) {
    console.error('No user_email in payload:', JSON.stringify(req.body));
    return res.status(400).json({ error: 'No email in payload' });
  }

  // Only upgrade on paid orders
  if (status !== 'paid') {
    console.log(`Order ${orderId} status is '${status}' — not upgrading`);
    return res.status(200).json({ ok: true, ignored: true, reason: `status=${status}` });
  }

  // ── 4. Upgrade plan in Supabase via REST ───────────────────────────────────
  const supabaseUrl        = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Supabase env vars not set');
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const updateRes = await fetch(`${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        supabaseServiceKey,
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      plan:               'pro',
      lemon_order_id:     orderId    || null,
      lemon_customer_id:  customerId || null,
    }),
  });

  if (!updateRes.ok) {
    const text = await updateRes.text();
    console.error(`Supabase PATCH failed (${updateRes.status}):`, text);
    return res.status(500).json({ error: 'Database update failed', detail: text });
  }

  console.log(`✓ Upgraded ${email} to Pro — order ${orderId}`);
  return res.status(200).json({ ok: true, email, orderId });
}
