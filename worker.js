/* ===============================
   1️⃣ CONFIGURATIE
================================*/
const MOLLIE_API_BASE = "https://api.mollie.com/v2";

/* ===============================
   2️⃣ DE ENTRY POINT (De fix)
================================*/
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Routeer het verzoek naar de juiste functie
    if (url.pathname.endsWith("/api/mollie/webhook")) {
      return await mollieWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/* ===============================
   3️⃣ DE WEBHOOK FUNCTIE
================================*/
async function mollieWebhook(request, env) {
  try {
    // Check of het een POST request is
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const data = await request.formData();
    const paymentId = data.get("id");
    if (!paymentId) return new Response("Missing ID", { status: 400 });

    // 1. Haal de betaling op
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });
    
    if (!paymentRes.ok) return new Response("Mollie API Error", { status: 502 });
    const payment = await paymentRes.json();

    // 2. CRUCIALE CHECK: Is dit een 'first' payment?
    if (payment.sequenceType !== "first") {
      return new Response("Ignored: Not a first payment");
    }

    // 3. Is de betaling gelukt?
    if (payment.status !== "paid") return new Response("Not paid");

    const customerId = payment.customerId;

    // 4. CHECK: BESTAAT ER AL EEN ABBO?
    const subsRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });
    const subs = await subsRes.json();

    const activeSub = subs?._embedded?.subscriptions?.find(
      s => s.status === "active" || s.status === "pending"
    );

    if (activeSub) {
      console.log(`⛔ Abonnement bestaat al voor klant ${customerId}`);
      return new Response("Subscription already exists");
    }

    // 5. Configureren van het abonnement
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      .toISOString()
      .split("T")[0]; 

    let amount = "1.00";
    let interval = "1 day";

    if (payment.metadata?.planType === "monthly-10") {
      amount = "10.00";
      interval = "1 month";
    } else if (payment.metadata?.planType === "monthly-15") {
      amount = "15.00";
      interval = "1 month";
    }

    const subPayload = {
      amount: { currency: "EUR", value: amount },
      interval,
      description: `Spectux Abonnement (${payment.metadata?.planType || 'test'})`,
      startDate: startDate,
    };

    const subRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(subPayload),
    });

    if (subRes.ok) {
      console.log(`✅ Abonnement succesvol gestart voor ${customerId}`);
      return new Response("OK");
    } else {
      const errorText = await subRes.text();
      console.error("❌ Abonnement fout:", errorText);
      return new Response("Failed to create sub but payment received"); 
    }
    
  } catch (e) {
    console.error("Webhook Error:", e);
    return new Response("Server Error", { status: 500 });
  }
}
