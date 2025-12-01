export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ===== CORS (Toestaan dat je frontend mag praten met deze worker) =====
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ===== PING (Om te kijken of hij online is) =====
    if (url.pathname === "/ping") {
      return json({ status: "ok", message: "Worker is running!" });
    }

    // ==========================================
    // 1. MOLLIE: CREATE PAYMENT
    // ==========================================
    if (url.pathname === "/create-payment" && request.method === "POST") {
      try {
        const { planName, price, email, name } = await request.json();

        // Klant aanmaken (nodig voor abonnementen later)
        const customerResponse = await fetch("https://api.mollie.com/v2/customers", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name, email }),
        });
        const customer = await customerResponse.json();

        // Betaling starten
        const paymentResponse = await fetch("https://api.mollie.com/v2/payments", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: { currency: "EUR", value: price },
            customerId: customer.id,
            sequenceType: "first", // Cruciaal voor incasso mandaat
            description: `Eerste betaling: ${planName}`,
            redirectUrl: "https://jouw-website.nl/payment-success", // PAS DIT AAN
            webhookUrl: `https://${url.hostname}/webhook`, // Verwijst naar zichzelf
          }),
        });

        const payment = await paymentResponse.json();
        return json({ checkoutUrl: payment._links.checkout.href });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ==========================================
    // 2. MOLLIE: WEBHOOK (Voor status updates)
    // ==========================================
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const id = formData.get("id");

        const statusResponse = await fetch(`https://api.mollie.com/v2/payments/${id}`, {
            headers: { "Authorization": `Bearer ${env.MOLLIE_API_KEY}` }
        });
        const payment = await statusResponse.json();

        // Hier kun je logica toevoegen:
        // Als payment.status === 'paid', activeer abonnement in je database
        // of stuur een welkomstmail via Mailjet (zie functie hieronder)

        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response("Webhook Error", { status: 500 });
      }
    }

    // ==========================================
    // 3. REGISTRATIE (Jouw Google Sheets & Mailjet Code)
    // ==========================================
    if (url.pathname === "/send-confirmation" && request.method === "POST") {
      try {
        const body = await request.json();
        const { email, name, parent_info, participants } = body;

        if (!email) return json({ success: false, error: "Email missing" }, 400);

        // 1. Mail sturen
        const html = buildHtmlEmail(name || "Gast", parent_info || {}, participants || []);
        const mailResult = await sendMailjet(email, name, html, env.MJ_APIKEY_PUBLIC, env.MJ_APIKEY_PRIVATE);

        // 2. Google Sheets
        if (participants) {
            for (const p of participants) {
            await appendToSheet(env, [
                new Date().toISOString(),
                parent_info?.email || "",
                parent_info?.firstname || "",
                p.firstname || "",
                p.lastname || "",
                p.club || "",
                // ... voeg hier al je velden toe die je nodig hebt
            ]);
            }
        }

        return json({ success: true, mailResult });
      } catch (e) {
        return json({ success: false, error: e.toString() }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  }
};

// =========================================
// HELPERS (Jouw bestaande functies)
// =========================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // Voor productie: zet hier je domein
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function sendMailjet(email, name, html, publicKey, privateKey) {
  const payload = {
    Messages: [{
        From: { Email: "info@tksportsacademy.nl", Name: "TK Sports Academy" },
        To: [{ Email: email, Name: name }],
        Subject: `Registration Confirmation - TK Sports Academy`,
        HTMLPart: html
    }]
  };
  const response = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${publicKey}:${privateKey}`),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return await response.json();
}

// Google Sheets Helpers (Jouw code, verkort voor overzicht)
function str2ab(str) {
  const cleaned = str.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, "").trim();
  const binary = atob(cleaned);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

async function getGoogleAccessToken(env) {
  // ... (Jouw exacte JWT logica hier behouden)
  // Ik kort het hier even in voor de leesbaarheid van het antwoord, 
  // maar in je bestand moet je jouw volledige JWT functie plakken.
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: env.GOOGLE_SERVICE_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  };
  
  // Import key logic...
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", str2ab(env.GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  
  const encoder = new TextEncoder();
  const unsigned = `${btoa(JSON.stringify(header))}.${btoa(JSON.stringify(claim))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(unsigned));
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  return (await tokenRes.json()).access_token;
}

async function appendToSheet(env, rowData) {
  const token = await getGoogleAccessToken(env);
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1!A:Z:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [rowData] })
    }
  );
}

function buildHtmlEmail(name, parent_info, participants) {
    // ... Jouw HTML template functie hier plakken
    return "<h1>Bedankt!</h1>"; // Placeholder
}
