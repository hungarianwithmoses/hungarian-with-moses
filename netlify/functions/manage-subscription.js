const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  const token = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing auth token' }) };
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
  }
  const userId = userData.user.id;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  const action = body.action;

  const { data: accessRow, error: accessError } = await supabaseAdmin
    .from('access')
    .select('plan, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (accessError || !accessRow) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        error: 'No access record found',
        debug_resolved_user_id: userId,
        debug_access_error: accessError ? accessError.message : null
      })
    };
  }

  if (action === 'status') {
    if (accessRow.plan !== 'monthly' || !accessRow.stripe_subscription_id) {
      return {
        statusCode: 200,
        body: JSON.stringify({ plan: accessRow.plan || 'none' })
      };
    }
    try {
      const sub = await stripe.subscriptions.retrieve(accessRow.stripe_subscription_id);
      return {
        statusCode: 200,
        body: JSON.stringify({
          plan: accessRow.plan,
          status: sub.status,
          cancel_at_period_end: sub.cancel_at_period_end,
          current_period_end: sub.current_period_end
        })
      };
    } catch (err) {
      return { statusCode: 200, body: JSON.stringify({ plan: accessRow.plan }) };
    }
  }

  if (action === 'cancel') {
    if (accessRow.plan !== 'monthly' || !accessRow.stripe_subscription_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No active subscription to cancel' }) };
    }
    try {
      const sub = await stripe.subscriptions.update(accessRow.stripe_subscription_id, {
        cancel_at_period_end: true
      });
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          current_period_end: sub.current_period_end
        })
      };
    } catch (err) {
      console.error('Cancel subscription error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not cancel subscription' }) };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
};
