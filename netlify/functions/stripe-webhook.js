const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Hungarian With Moses <onboarding@resend.dev>';
const SITE_URL = 'https://hungarianwithmoses.com';

async function sendPaymentEmail(toEmail, plan) {
  if (!RESEND_API_KEY || !toEmail) return;

  const planLabel = plan === 'lifetime' ? 'Lifetime Access' : 'Monthly Subscription';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #97c47c; color: #ffffff;">
      <h1 style="font-size: 22px; margin: 0 0 16px;">You're in! 🎉</h1>
      <p style="font-size: 15px; line-height: 1.6;">
        Thanks for getting <strong>${planLabel}</strong> to Learn Hungarian. Your course is unlocked and ready whenever you are.
      </p>
      <p style="margin: 28px 0;">
        <a href="${SITE_URL}" style="background:#ffffff;color:#33502a;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;">
          Start learning →
        </a>
      </p>
      <p style="font-size: 13px; line-height: 1.6; color: #eaf5e2;">
        If you have any questions, just reply to this email.<br>
        — Moses
      </p>
    </div>
  `;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: toEmail,
        subject: "You're in — Learn Hungarian is unlocked!",
        html
      })
    });
  } catch (err) {
    console.error('Failed to send payment confirmation email:', err);
  }
}

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

      const email = session.customer_details?.email || session.customer_email;
      await sendPaymentEmail(email, plan);
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
