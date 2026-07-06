const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const userId = session.client_reference_id;

      if (!userId) {
        console.error('No client_reference_id on checkout session — cannot link payment to a user.');
        return { statusCode: 200, body: 'No user id, ignored.' };
      }

      const plan = session.mode === 'subscription' ? 'monthly' : 'lifetime';

      await supabase.from('access').upsert({
        user_id: userId,
        plan: plan,
        stripe_customer_id: session.customer || null,
        stripe_subscription_id: session.subscription || null,
        updated_at: new Date().toISOString()
      });
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const subscription = stripeEvent.data.object;
      await supabase
        .from('access')
        .update({ plan: 'none', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', subscription.id);
    }

    if (stripeEvent.type === 'customer.subscription.updated') {
      const subscription = stripeEvent.data.object;
      if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
        await supabase
          .from('access')
          .update({ plan: 'none', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subscription.id);
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Error handling webhook event:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
