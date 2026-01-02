/* ============================================================
   CONFIGURATIE & HELPER FUNCTIONS
   ============================================================ */
const MOLLIE_API_BASE = "https://api.mollie.com/v2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // Voor productie: vervang door je echte domein
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ============================================================
   ENTRY POINT (Router)
   ============================================================ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Handel CORS preflight af
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 2. Routeer naar de juiste functie
    if (url.pathname.endsWith("/api/mollie/start-subscription")) {
      return await handleStartSubscription(request, env);
    }

    if (url.pathname.endsWith("/api/mollie/webhook")) {
      return await handleWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/* ============================================================
   FUNCTIE 1: START SUBSCRIPTION (Aangeroepen door Frontend)
   ============================================================ */
async function handleStartSubscription(request, env) {
  try {
    const { name, email, plan } = await request.json();

    // A. Maak een Customer aan bij Mollie
    const customerRes = await fetch(`${MOLLIE_API_BASE}/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, email }),
    });
    const customer = await customerRes.json();

    if (!customerRes.ok) throw new Error("Mollie Customer creation failed");

    // B. Bepaal het bedrag op basis van planKey uit frontend
    // NU OOK VOOR HET 30 EURO PLAN
    let amountValue = "10.00"; 
    if (plan === "monthly15") {
      amountValue = "15.00";
    } else if (plan === "monthly30") {
      amountValue = "30.00";
    } else if (plan === "monthly10") {
      amountValue = "10.00";
    }

    // C. Maak de eerste betaling (First Payment) aan
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { currency: "EUR", value: amountValue },
        customerId: customer.id,
        sequenceType: "first", 
        description: `Eerste betaling Spectux: ${plan}`,
        redirectUrl: "https://spectux.nl/success", // Pas dit aan naar je eigen site
        webhookUrl: `${new URL(request.url).origin}/api/mollie/webhook`,
        metadata: { planType: plan },
      }),
    });

    const payment = await paymentRes.json();
    if (!paymentRes.ok) throw new Error(payment.detail || "Payment creation failed");

    return new Response(JSON.stringify({ checkoutUrl: payment._links.checkout.href }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
}

/* ============================================================
   FUNCTIE 2: WEBHOOK (Aangeroepen door Mollie na betaling)
   ============================================================ */
async function handleWebhook(request, env) {
  try {
    const data = await request.formData();
    const paymentId = data.get("id");

    if (!paymentId) return new Response("OK");

    // 1. Haal betaling op
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });
    const payment = await paymentRes.json();

    // 2. Beveiliging: Alleen actie bij 'paid' en 'first'
    if (payment.status !== "paid" || payment.sequenceType !== "first") {
      return new Response("OK"); 
    }

    const customerId = payment.customerId;

    // 3. Check of er al een abonnement loopt
    const subsRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });
    const existing = await subsRes.json();
    const hasActive = existing?._embedded?.subscriptions?.some(s => s.status === "active");

    if (hasActive) return new Response("OK");

    // 4. Maak het abonnement aan
    // Dit pakt automatisch het bedrag over van de eerste betaling (dus ook de €30)
    const startDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
      .toISOString()
      .split("T")[0];

    const subPayload = {
      amount: payment.amount,
      interval: "1 month",
      description: `Abonnement Spectux: ${payment.metadata.planType}`,
      startDate: startDate,
    };

    await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(subPayload),
    });

    return new Response("OK");
  } catch (e) {
    console.error("Webhook Error:", e);
    return new Response("Internal Error", { status: 500 });
  }
}
