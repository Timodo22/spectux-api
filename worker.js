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
    
    console.log(`📨 Incoming request: ${request.method} ${url.pathname}`);

    // CORS preflight
    if (request.method === "OPTIONS") {
      console.log("✅ CORS preflight - returning 204");
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/custom-test") {
      console.log("🎯 Routing to handleCreateCustomTestPayment");
      return handleCreateCustomTestPayment(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/api/mollie/webhook") {
      console.log("🎯 Routing to handleWebhook");
      return handleWebhook(request, env);
    }

    console.log("❌ Route not found");
    return new Response(JSON.stringify({ error: "Not found" }), { 
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(),
      },
    });
  },
};

async function handleCreateCustomTestPayment(request, env, url) {
  console.log("🚀 Starting handleCreateCustomTestPayment");
  
  try {
    // Check of API key aanwezig is
    if (!env.MOLLIE_API_KEY) {
      console.error("❌ MOLLIE_API_KEY niet gevonden in environment");
      return new Response(
        JSON.stringify({ error: "Server configuratie fout: API key ontbreekt" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(),
          },
        }
      );
    }
    
    console.log("✅ API key found");

    const body = await request.json().catch((err) => {
      console.error("❌ Failed to parse JSON body:", err);
      return {};
    });
    
    console.log("📦 Request body:", JSON.stringify(body, null, 2));

    const { name, email, redirectBaseUrl } = body;

    if (!name || !email || !redirectBaseUrl) {
      console.error("❌ Missing required fields:", { name, email, redirectBaseUrl });
      return new Response(
        JSON.stringify({ 
          error: "name, email en redirectBaseUrl zijn verplicht",
          received: { name, email, redirectBaseUrl }
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(),
          },
        }
      );
    }

    console.log("✅ All required fields present");

    // 1. Maak Mollie customer
    console.log("📞 Creating Mollie customer...");
    const customerPayload = {
      name,
      email,
      metadata: {
        localCustomerRef: email,
      },
    };
    console.log("Customer payload:", JSON.stringify(customerPayload, null, 2));

    const customerRes = await fetch(`${MOLLIE_API_BASE}/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(customerPayload),
    });

    console.log("Customer response status:", customerRes.status);

    if (!customerRes.ok) {
      const errText = await customerRes.text();
      console.error("❌ Error creating customer:", errText);
      return new Response(
        JSON.stringify({ 
          error: "Kon Mollie klant niet aanmaken",
          details: errText,
          status: customerRes.status
        }),
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
    console.log("✅ Customer created:", customer.id);

    // 2. Maak eerste betaling met iDEAL - €1
    // We forceren iDEAL voor nu, dit werkt altijd in test mode
    console.log("📞 Creating first payment with iDEAL...");
    
    const paymentPayload = {
      amount: {
        currency: "EUR",
        value: "1.00",
      },
      customerId: customer.id,
      method: "ideal", // Forceer iDEAL voor test
      description: "Spectux Custom testabonnement - Eerste betaling €1",
      redirectUrl: `${redirectBaseUrl}/mollie/return?customerId=${encodeURIComponent(
        customer.id
      )}`,
      webhookUrl: `${url.origin}/api/mollie/webhook`,
      metadata: {
        plan: "custom-test",
        planName: "Custom Solution testabonnement",
        setupForRecurring: "true", // marker dat dit voor recurring is
      },
    };
    console.log("Payment payload:", JSON.stringify(paymentPayload, null, 2));

    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentPayload),
    });

    console.log("Payment response status:", paymentRes.status);

    if (!paymentRes.ok) {
      const errText = await paymentRes.text();
      console.error("❌ Error creating payment:", errText);
      return new Response(
        JSON.stringify({ 
          error: "Kon Mollie betaling niet aanmaken",
          details: errText,
          status: paymentRes.status
        }),
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
    console.log("✅ Payment created:", payment.id);
    console.log("Payment object:", JSON.stringify(payment, null, 2));
    
    const checkoutUrl = payment?._links?.checkout?.href;
    
    if (!checkoutUrl) {
      console.error("❌ No checkout URL in payment response");
      return new Response(
        JSON.stringify({ 
          error: "Geen checkout URL ontvangen van Mollie",
          payment: payment
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(),
          },
        }
      );
    }

    console.log("✅ Checkout URL:", checkoutUrl);

    return new Response(
      JSON.stringify({ 
        checkoutUrl, 
        customerId: customer.id,
        paymentId: payment.id
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(),
        },
      }
    );
  } catch (err) {
    console.error("❌ handleCreateCustomTestPayment error:", err);
    console.error("Error stack:", err.stack);
    return new Response(
      JSON.stringify({ 
        error: "Onbekende fout in worker",
        message: err.message,
        stack: err.stack
      }),
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
  console.log("🎣 Webhook received");
  
  try {
    // Mollie stuurt application/x-www-form-urlencoded met id=<paymentId>
    const formData = await request.formData();
    const paymentId = formData.get("id");

    console.log("Payment ID from webhook:", paymentId);

    if (!paymentId) {
      console.error("❌ Webhook zonder payment id");
      return new Response("Missing payment id", { status: 400 });
    }

    // 1. Haal betaling op
    console.log("📞 Fetching payment details...");
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
      },
    });

    if (!paymentRes.ok) {
      const errText = await paymentRes.text();
      console.error("❌ Error fetching payment in webhook:", errText);
      return new Response("Error", { status: 200 });
    }

    const payment = await paymentRes.json();

    console.log("✅ Payment status:", payment.status);
    console.log("Payment metadata:", JSON.stringify(payment.metadata, null, 2));
    console.log("Payment method:", payment.method);

    // Alleen bij betaalde betaling voor ons testplan
    if (payment.status === "paid" && payment.metadata?.plan === "custom-test") {
      console.log("💰 Payment is paid for custom-test plan");
      
      const customerId = payment.customerId;

      if (!customerId) {
        console.error("❌ Geen customerId op payment");
        return new Response("OK", { status: 200 });
      }

      console.log("👤 Customer ID:", customerId);

      // 2. Maak een mandaat aan voor toekomstige betalingen
      // Dit gebruiken we voor de recurring subscription
      console.log("📞 Creating mandate for recurring payments...");
      
      const mandatePayload = {
        method: "directdebit",
        consumerName: payment.details?.consumerName || "Test Customer",
        consumerAccount: payment.details?.consumerAccount || "NL00TEST0000000000",
      };
      console.log("Mandate payload:", JSON.stringify(mandatePayload, null, 2));

      const mandateRes = await fetch(
        `${MOLLIE_API_BASE}/customers/${customerId}/mandates`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(mandatePayload),
        }
      );

      if (!mandateRes.ok) {
        const errText = await mandateRes.text();
        console.error("❌ Error creating mandate:", errText);
        console.log("⚠️ Skipping mandate creation, will create subscription without it");
      } else {
        const mandate = await mandateRes.json();
        console.log("✅ Mandate created:", mandate.id);
      }

      // 3. Maak subscription €1 / dag
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const startDate = tomorrow.toISOString().slice(0, 10); // Start morgen

      console.log("📞 Creating subscription starting:", startDate);

      const subscriptionPayload = {
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
      };
      console.log("Subscription payload:", JSON.stringify(subscriptionPayload, null, 2));

      const subRes = await fetch(
        `${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(subscriptionPayload),
        }
      );

      if (!subRes.ok) {
        const errText = await subRes.text();
        console.error("❌ Error creating subscription:", errText);
        return new Response("Webhook received, subscription failed", {
          status: 200,
        });
      }

      const sub = await subRes.json();
      console.log("✅ Subscription created:", sub.id, "for customer", customerId);
      console.log("📅 Next payment on:", sub.nextPaymentDate);
    } else {
      console.log("ℹ️ Payment not eligible for subscription creation");
      console.log("Status:", payment.status, "Plan:", payment.metadata?.plan);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    console.error("Error stack:", err.stack);
    return new Response("Error", { status: 200 });
  }
}
