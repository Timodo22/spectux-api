const MOLLIE_API_BASE = "https://api.mollie.com/v2";

// Simpele CORS helper
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // eventueel beperken tot je frontend origin
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/custom-test") {
      return handleCreateCustomTestPayment(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleCreateCustomTestPayment(request, env, url) {
  try {
    const body = await request.json().catch(() => ({}));
    const { name, email, redirectBaseUrl } = body;

    if (!name || !email || !redirectBaseUrl) {
      return new Response(
        JSON.stringify({ error: "name, email en redirectBaseUrl zijn verplicht" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(),
          },
        }
      );
    }

    // 1. Maak Mollie customer
    const customerRes = await fetch(`${MOLLIE_API_BASE}/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        email,
        metadata: {
          localCustomerRef: email, // hier kun je bv. je eigen user-id gebruiken
        },
      }),
    });

    if (!customerRes.ok) {
      const errText = await customerRes.text();
      console.error("Error creating customer:", errText);
      return new Response(
        JSON.stringify({ error: "Kon Mollie klant niet aanmaken" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(),
          },
        }
      );
    }

    const customer = await customerRes.json();

    // 2. Maak eerste Direct Debit payment van €1
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: {
          currency: "EUR",
          value: "1.00",
        },
        customerId: customer.id,
        sequenceType: "first",
        method: "directdebit",
        description: "Spectux Custom testabonnement €1 / dag",
        redirectUrl: `${redirectBaseUrl}/mollie/return?customerId=${encodeURIComponent(
          customer.id
        )}`,
        webhookUrl: `${url.origin}/api/mollie/webhook`,
        metadata: {
          plan: "custom-test",
          planName: "Custom Solution testabonnement",
        },
      }),
    });

    if (!paymentRes.ok) {
      const errText = await paymentRes.text();
      console.error("Error creating payment:", errText);
      return new Response(
        JSON.stringify({ error: "Kon Mollie betaling niet aanmaken" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(),
          },
        }
      );
    }

    const payment = await paymentRes.json();
    const checkoutUrl = payment?._links?.checkout?.href;

    return new Response(
      JSON.stringify({ checkoutUrl, customerId: customer.id }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(),
        },
      }
    );
  } catch (err) {
    console.error("handleCreateCustomTestPayment error:", err);
    return new Response(
      JSON.stringify({ error: "Onbekende fout in worker" }),
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

async function handleWebhook(request, env) {
  try {
    // Mollie stuurt application/x-www-form-urlencoded met id=<paymentId>
    const formData = await request.formData();
    const paymentId = formData.get("id");

    if (!paymentId) {
      console.error("Webhook zonder payment id");
      return new Response("Missing payment id", { status: 400 });
    }

    // 1. Haal betaling op
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
      },
    });

    if (!paymentRes.ok) {
      const errText = await paymentRes.text();
      console.error("Error fetching payment in webhook:", errText);
      return new Response("Error", { status: 200 });
    }

    const payment = await paymentRes.json();

    console.log("Webhook payment status:", payment.status, "metadata:", payment.metadata);

    // Alleen bij betaalde betaling voor ons testplan
    if (payment.status === "paid" && payment.metadata?.plan === "custom-test") {
      const customerId = payment.customerId;

      if (!customerId) {
        console.error("Geen customerId op payment");
        return new Response("OK", { status: 200 });
      }

      // 2. Maak subscription €1 / dag
      const today = new Date();
      const startDate = today.toISOString().slice(0, 10); // YYYY-MM-DD

      const subRes = await fetch(
        `${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: {
              currency: "EUR",
              value: "1.00",
            },
            interval: "1 day",
            description: "Spectux Custom testabonnement €1 / dag",
            startDate,
            metadata: {
              plan: "custom-test",
            },
          }),
        }
      );

      if (!subRes.ok) {
        const errText = await subRes.text();
        console.error("Error creating subscription:", errText);
        // Nog steeds 200 teruggeven zodat Mollie niet blijft retried
        return new Response("Webhook received, subscription failed", {
          status: 200,
        });
      }

      const sub = await subRes.json();
      console.log("Subscription created:", sub.id, "for customer", customerId);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Webhook error:", err);
    // 200 zodat Mollie niet blijft retried
    return new Response("Error", { status: 200 });
  }
}
