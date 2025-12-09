const MOLLIE_API_BASE = "https://api.mollie.com/v2";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/start-subscription") {
      return startSubscription(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/webhook") {
      return mollieWebhook(request, env);
    }

    // VOEG CORS TOE aan de 404 response
    return new Response("Not found", { 
      status: 404,
      headers: corsHeaders()
    });
  },
};

/* ===============================
    1️⃣ START BETALING + PLAN KEUZE
================================*/
async function startSubscription(request, env, url) {
  try {
    const { name, email, plan } = await request.json();

    if (!name || !email || !plan) {
      return new Response("Missing data", { 
        status: 400,
        headers: corsHeaders(), // ⬅️ CORS toegevoegd
      });
    }

    const plans = {
      test: { amount: "0.01", type: "daily-test" },
      monthly10: { amount: "10.00", type: "monthly-10" },
      monthly15: { amount: "15.00", type: "monthly-15" },
    };

    const selectedPlan = plans[plan];
    if (!selectedPlan) return new Response("Invalid plan", { 
      status: 400,
      headers: corsHeaders(), // ⬅️ CORS toegevoegd
    });

    // 1️⃣ Customer
    const customerRes = await fetch(`${MOLLIE_API_BASE}/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, email }),
    });
    const customer = await customerRes.json();
    
    // Foutafhandeling voor Mollie API errors
    if (customer.status === 401 || customer.status >= 400) {
        return new Response(JSON.stringify({ error: customer.detail || "Mollie customer aanmaak mislukt" }), {
            status: customer.status || 500,
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders(), // ⬅️ CORS toegevoegd
            }
        });
    }

    // 2️⃣ First payment (MANDATE)
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { currency: "EUR", value: selectedPlan.amount },
        customerId: customer.id,
        sequenceType: "first",
        description: "Spectux Verificatie Betaling",
        redirectUrl: "https://jouwsite.nl/succes",
        webhookUrl: `${url.origin}/api/mollie/webhook`,
        metadata: {
          planType: selectedPlan.type,
        },
      }),
    });

    const payment = await paymentRes.json();
    
    // Foutafhandeling voor Mollie API errors
    if (payment.status === 401 || payment.status >= 400) {
        return new Response(JSON.stringify({ error: payment.detail || "Mollie betalingsaanmaak mislukt" }), {
            status: payment.status || 500,
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders(), // ⬅️ CORS toegevoegd
            }
        });
    }

    // ✅ Succes Response
    return new Response(
      JSON.stringify({ checkoutUrl: payment._links.checkout.href }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(), // ⬅️ CORS toegevoegd
        },
      }
    );
  } catch (err) {
    // Vang JSON parse errors en andere onverwachte worker errors af
    return new Response(
      JSON.stringify({ error: `Worker error: ${err.message}` }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(), // ⬅️ CORS toegevoegd
        },
      }
    );
  }
}

/* ===============================
    2️⃣ VEILIGE WEBHOOK
================================*/
async function mollieWebhook(request, env) {
  const data = await request.formData();
  const paymentId = data.get("id");
  if (!paymentId) return new Response("Missing ID", { status: 400 });

  const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
  });
  const payment = await paymentRes.json();

  if (payment.status !== "paid") return new Response("Not paid");

  const customerId = payment.customerId;

  // ✅ DUBBELCHECK: BESTAAT ER AL EEN ABBO?
  const subsRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
    headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
  });
  const subs = await subsRes.json();

  const activeSub = subs?._embedded?.subscriptions?.find(s => s.status === "active");
  if (activeSub) {
    console.log("⛔ Abonnement bestaat al → niets doen");
    return new Response("Subscription already exists");
  }

  // ✅ STARTDATUM OP 1E VAN MAAND
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    .toISOString()
    .split("T")[0];

  let amount = "1.00";
  let interval = "1 day";

  if (payment.metadata.planType === "monthly-10") {
    amount = "10.00";
    interval = "1 month";
  }

  if (payment.metadata.planType === "monthly-15") {
    amount = "15.00";
    interval = "1 month";
  }

  const subPayload = {
    amount: { currency: "EUR", value: amount },
    interval,
    description: "Spectux Abonnement",
    startDate,
    webhookUrl: `${new URL(request.url).origin}/api/mollie/webhook`,
  };

  const subRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(subPayload),
  });

  if (subRes.ok) {
    console.log("✅ Abonnement veilig aangemaakt");
  } else {
    console.error("❌ Abonnement fout", await subRes.text());
  }

  return new Response("OK");
}
