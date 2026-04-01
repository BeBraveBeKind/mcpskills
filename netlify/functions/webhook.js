/**
 * POST /.netlify/functions/webhook
 * LemonSqueezy payment webhook handler.
 *
 * Receives order_created and subscription_created events.
 * Stores unlock tokens and generates API keys.
 *
 * Security: HMAC SHA-256 signature verification.
 */

const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');
const { generateApiKey } = require('../../lib/auth');
const { sendApiKeyDelivery } = require('../../lib/email');

function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;
  try {
    const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

exports.handler = async (event, context) => {
  // Initialize Blobs from Lambda context
  connectLambda(event);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://mcpskills.io',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  // Verify webhook signature — REQUIRED, fail closed
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const signature = event.headers?.['x-signature'];

  if (!secret) {
    console.error('LEMONSQUEEZY_WEBHOOK_SECRET not configured');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook not configured' }) };
  }
  if (!verifySignature(event.body, signature, secret)) {
    console.error('Webhook signature verification failed');
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const eventName = payload.meta?.event_name;
  const customData = payload.meta?.custom_data || {};
  const attrs = payload.data?.attributes || {};
  const email = attrs.user_email || customData.email || '';
  const orderId = payload.data?.id || '';

  const emailRedacted = email ? email.replace(/(.{2}).*(@.*)/, '$1***$2') : 'unknown';
  console.log(`Webhook received: ${eventName}, order: ${orderId}, email: ${emailRedacted}`);

  const store = getStore('purchases');

  try {
    if (eventName === 'order_created') {
      const total = attrs.total || 0;
      const totalUsd = total / 100;

      if (totalUsd <= 15) {
        // Single report ($9)
        const sessionId = customData.session;
        const repo = customData.repo;

        if (!sessionId) {
          console.error('No session ID in webhook custom data');
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, warning: 'No session ID' }) };
        }

        const tokenRecord = {
          orderId, repo, email,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          consumed: false,
        };
        await store.set(`token:${sessionId}`, JSON.stringify(tokenRecord));
        await store.set(`purchase:${orderId}`, JSON.stringify({
          email, repo, amount: totalUsd, type: 'single', createdAt: new Date().toISOString(),
        }));

        console.log(`Stored unlock token for order ${orderId}`);

      } else {
        // 10-pack ($29)
        const apiKey = await generateApiKey(email, 10, 'purchase');

        await store.set(`purchase:${orderId}`, JSON.stringify({
          email, amount: totalUsd, type: '10-pack', keyPrefix: apiKey.slice(0, 12), createdAt: new Date().toISOString(),
        }));

        const sessionId = customData.session;
        if (sessionId) {
          await store.set(`token:${sessionId}`, JSON.stringify({
            orderId, email, type: '10-pack', apiKey,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            consumed: false,
          }));
        }

        console.log(`Generated 10-pack key for order ${orderId}`);

        // Email the API key
        await sendApiKeyDelivery({ email, apiKey, credits: 10, type: '10-pack' });
      }

    } else if (eventName === 'subscription_created') {
      const apiKey = await generateApiKey(email, null, 'subscription');

      await store.set(`purchase:${orderId}`, JSON.stringify({
        email, amount: 12, type: 'pro', keyPrefix: apiKey.slice(0, 12), createdAt: new Date().toISOString(),
      }));

      const sessionId = customData.session;
      if (sessionId) {
        await store.set(`token:${sessionId}`, JSON.stringify({
          orderId, email, type: 'pro', apiKey,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          consumed: false,
        }));
      }

      console.log(`Generated Pro key for order ${orderId}`);

      // Email the API key
      await sendApiKeyDelivery({ email, apiKey, credits: null, type: 'pro' });

    } else {
      console.log(`Unhandled webhook event: ${eventName}`);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error('Webhook processing error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
