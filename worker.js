const MOLLIE_API_BASE = "https://api.mollie.com/v2";

// Simpele CORS helper
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS preflight handling
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Route: Maak betaling aan (Start abonnement)
    if (request.method === "POST" && url.pathname === "/api/mollie/custom-test") {
      return handleCreateCustomTestPayment(request, env, url);
    }

    // Route: Mollie Webhook
    if (request.method === "POST" && url.pathname === "/api/mollie/webhook") {
      return handleWebhook(request, env);
    }

    return new Response(JSON.stringify({ error: "Not found" }), { 
      status: 404, 
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  },
};

async function handleCreateCustomTestPayment(request, env, url) {
  try {
    if (!env.MOLLIE_API_KEY) {
      throw new Error("MOLLIE_API_KEY ontbreekt in environment variables");
    }

    const body = await request.json().catch(() => ({}));
    const { name, email, redirectBaseUrl } = body;

    if (!name || !email || !redirectBaseUrl) {
      return new Response(
        JSON.stringify({ error: "Naam, email en redirectBaseUrl zijn verplicht." }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } }
      );
    }

    // 1. Maak Mollie customer (Klant)
    console.log(`👤 Creating customer: ${email}`);
    const customerRes = await fetch(`${MOLLIE_API_BASE}/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        email,
        metadata: { source: "spectux_custom_flow" },
      }),
    });

    if (!customerRes.ok) throw new Error(`Fout bij aanmaken klant: ${await customerRes.text()}`);
    const customer = await customerRes.json();

    // 2. Maak EERSTE betaling aan (Sequence Type: First)
    // Dit is CRUCIAAL voor abonnementen. Dit maakt het mandaat aan.
    console.log(`💳 Creating first payment for customer ${customer.id}`);
    
    const paymentPayload = {
      amount: { currency: "EUR", value: "0.01" }, // Eerste betaling kan 1 cent zijn ter verificatie, of direct het abonnementsbedrag
      customerId: customer.id,
      sequenceType: "first", // <--- DIT IS HET BELANGRIJKSTE ONDERDEEL VOOR ABONNEMENTEN
      description: "Verificatie incasso Spectux - Custom Plan",
      redirectUrl: `${redirectBaseUrl}/?payment=success`, // Stuur terug naar je site
      webhookUrl: `${url.origin}/api/mollie/webhook`,
      metadata: {
        plan: "custom-test",
        type: "first_payment_subscription"
      },
    };

    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentPayload),
    });

    if (!paymentRes.ok) throw new Error(`Fout bij aanmaken betaling: ${await paymentRes.text()}`);
    const payment = await paymentRes.json();

    return new Response(
      JSON.stringify({ 
        checkoutUrl: payment._links.checkout.href,
        customerId: customer.id,
        paymentId: payment.id 
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } }
    );

  } catch (err) {
    console.error("❌ API Error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders() } }
    );
  }
}

async function handleWebhook(request, env) {
  try {
    const formData = await request.formData();
    const paymentId = formData.get("id");

    if (!paymentId) return new Response("Missing ID", { status: 400 });

    // 1. Haal status op bij Mollie
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });
    const payment = await paymentRes.json();

    // 2. Check of betaling geslaagd is én bedoeld voor ons abonnement
    if (payment.status === "paid" && payment.metadata?.type === "first_payment_subscription") {
      console.log(`✅ First payment ${paymentId} paid. Setting up subscription...`);
      
      const customerId = payment.customerId;

      // 3. (Optioneel) Check of er nu een mandaat is (zou automatisch moeten zijn door sequenceType: first)
      // We gaan er vanuit dat Mollie dit geregeld heeft en maken direct het abonnement aan.

      // 4. Start het dagelijkse abonnement
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1); // Start morgen
      const startDate = tomorrow.toISOString().slice(0, 10);

      const subscriptionPayload = {
        amount: { currency: "EUR", value: "1.00" }, // Dagelijks 1 euro
        interval: "1 day",
        description: "Spectux Dagelijks Abonnement",
        startDate: startDate, 
        webhookUrl: `${new URL(request.url).origin}/api/mollie/webhook`, // Webhook voor de terugkerende betalingen zelf
        metadata: {
            plan: "custom-test-recurring"
        }
      };

      console.log("📅 Creating subscription:", JSON.stringify(subscriptionPayload));

      const subRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(subscriptionPayload),
      });

      if (subRes.ok) {
        console.log("🚀 Subscription created successfully!");
      } else {
        console.error("❌ Failed to create subscription:", await subRes.text());
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Webhook Error:", err);
    return new Response("Error", { status: 500 });
  }
}
