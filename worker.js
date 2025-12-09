const MOLLIE_API_BASE = "https://api.mollie.com/v2";

// Hulpfunctie om CORS headers toe te voegen
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

    // 1. OPTIONS (Preflight) afhandeling
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/start-subscription") {
      return startSubscription(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/webhook") {
      return mollieWebhook(request, env);
    }

    // 404 Not Found (met CORS headers)
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
      return new Response(JSON.stringify({ error: "Missing data (Name, Email, or Plan)" }), { 
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    const plans = {
      test: { amount: "0.01", type: "daily-test" },
      monthly10: { amount: "10.00", type: "monthly-10" },
      monthly15: { amount: "15.00", type: "monthly-15" },
    };

    const selectedPlan = plans[plan];
    if (!selectedPlan) return new Response(JSON.stringify({ error: "Invalid plan selected" }), { 
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });

    // 1️⃣ Customer aanmaken of vinden (Mollie maakt een nieuwe klant als de email uniek is)
    const customerRes = await fetch(`${MOLLIE_API_BASE}/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, email }),
    });
    const customer = await customerRes.json();
    
    if (customer.status === 401 || customer.status >= 400) {
        return new Response(JSON.stringify({ error: customer.detail || "Mollie customer aanmaak/opzoeken mislukt." }), {
            status: customer.status || 500,
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders(),
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
        description: `Verificatie Betaling ${selectedPlan.type}`,
        redirectUrl: "https://jouwsite.nl/succes", // Wijzig naar je succes pagina
        webhookUrl: `${url.origin}/api/mollie/webhook`,
        metadata: {
          planType: selectedPlan.type,
          customerName: name,
        },
      }),
    });

    const payment = await paymentRes.json();
    
    if (payment.status === 401 || payment.status >= 400 || !payment._links?.checkout?.href) {
        return new Response(JSON.stringify({ error: payment.detail || "Mollie betalingsaanmaak mislukt. Geen checkout URL." }), {
            status: payment.status || 500,
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders(),
            }
        });
    }

    // ✅ Succes Response (stuurt de checkout URL terug)
    return new Response(
      JSON.stringify({ checkoutUrl: payment._links.checkout.href }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(),
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
          ...corsHeaders(),
        },
      }
    );
  }
}

/* ===============================
    2️⃣ VEILIGE WEBHOOK (IDEMPOTENTIE)
================================*/
async function mollieWebhook(request, env) {
  const data = await request.formData();
  const paymentId = data.get("id");
  if (!paymentId) return new Response("Missing ID", { status: 400 });

  const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
  });
  const payment = await paymentRes.json();

  // Alleen doorgaan als de betaling betaald is (paid)
  if (payment.status !== "paid") return new Response("Not paid");

  const customerId = payment.customerId;

  // ✅ DUBBELCHECK: BESTAAT ER AL EEN ABBO? (Voorkomt dubbele aanmaak)
  const subsRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
    headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
  });
  const subs = await subsRes.json();

  const activeSub = subs?._embedded?.subscriptions?.find(s => s.status === "active");
  if (activeSub) {
    console.log(`⛔ Abonnement ${activeSub.id} bestaat al voor klant ${customerId} → niets doen`);
    return new Response("Subscription already exists");
  }

  // ✅ STARTDATUM OP 1E VAN MAAND
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    .toISOString()
    .split("T")[0]; // Zet de datum op de 1e van de volgende maand

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
  
  // Voeg een eerste afschrijvingsdatum toe om te zorgen dat het abonnement
  // daadwerkelijk start op de 1e van de volgende maand.
  const firstPaymentDate = startDate; 

  const subPayload = {
    amount: { currency: "EUR", value: amount },
    interval,
    description: `Spectux Abonnement (${payment.metadata.planType})`,
    startDate: firstPaymentDate,
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
    console.log(`✅ Abonnement veilig aangemaakt voor klant ${customerId}, start ${firstPaymentDate}`);
  } else {
    console.error("❌ Abonnement fout", await subRes.text());
  }

  return new Response("OK");
}
