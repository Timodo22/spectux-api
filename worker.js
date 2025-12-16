/* ===============================
   2️⃣ VEILIGE WEBHOOK (FIXED)
================================*/
async function mollieWebhook(request, env) {
  try {
    const data = await request.formData();
    const paymentId = data.get("id");
    if (!paymentId) return new Response("Missing ID", { status: 400 });

    // 1. Haal de betaling op
    const paymentRes = await fetch(`${MOLLIE_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });
    const payment = await paymentRes.json();

    // 2. CRUCIALE CHECK: Is dit een 'first' payment?
    // Als dit een 'recurring' (automatische incasso) is, stoppen we direct.
    // Dit voorkomt dat een lopend abonnement probeert zichzelf opnieuw aan te maken.
    if (payment.sequenceType !== "first") {
      return new Response("Ignored: Not a first payment (sequenceType is recurring or oneoff)");
    }

    // 3. Is de betaling gelukt?
    if (payment.status !== "paid") return new Response("Not paid");

    const customerId = payment.customerId;

    // 4. CHECK: BESTAAT ER AL EEN ABBO? (Race condition preventie)
    const subsRes = await fetch(`${MOLLIE_API_BASE}/customers/${customerId}/subscriptions`, {
      headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
    });
    const subs = await subsRes.json();

    // Check op 'active' OF 'pending' (soms staat hij nog op pending bij net aanmaken)
    const activeSub = subs?._embedded?.subscriptions?.find(
      s => s.status === "active" || s.status === "pending"
    );

    if (activeSub) {
      console.log(`⛔ Abonnement bestaat al voor klant ${customerId} (ID: ${activeSub.id})`);
      return new Response("Subscription already exists");
    }

    // 5. Configureren van het abonnement
    const now = new Date();
    // Startdatum op de 1e van de volgende maand
    // LET OP: Voor je test (daily) moet je dit misschien even weglaten of aanpassen,
    // maar voor productie (monthly) is dit goed.
    const startDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      .toISOString()
      .split("T")[0]; 

    let amount = "1.00";
    let interval = "1 day"; // Standaard test

    // Productie logica
    if (payment.metadata?.planType === "monthly-10") {
      amount = "10.00";
      interval = "1 month";
    }
    if (payment.metadata?.planType === "monthly-15") {
      amount = "15.00";
      interval = "1 month";
    }

    const subPayload = {
      amount: { currency: "EUR", value: amount },
      interval,
      description: `Spectux Abonnement (${payment.metadata?.planType || 'test'})`,
      startDate: startDate,
      // BELANGRIJK: Hier halen we de webhookUrl WEG of zetten we hem naar een andere endpoint.
      // Als je hem hier laat staan, vuurt hij elke maand deze functie weer aan.
      // Omdat we bovenin nu checken op 'sequenceType !== first', is het nu veilig,
      // maar het is netter om het leeg te laten als je geen database update nodig hebt.
      // webhookUrl: `${new URL(request.url).origin}/api/mollie/webhook`, 
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
      console.log(`✅ Abonnement succesvol gestart voor ${customerId} per ${startDate}`);
    } else {
      const errorText = await subRes.text();
      console.error("❌ Abonnement fout:", errorText);
      // Return 200 om Mollie te laten stoppen met retryen, ook al faalde de sub creatie (anders krijg je loops)
      return new Response("Failed to create sub but payment received"); 
    }

    return new Response("OK");
    
  } catch (e) {
    console.error("Webhook Error:", e);
    // Bij een echte code error sturen we 500 zodat Mollie het later nog eens probeert
    return new Response("Server Error", { status: 500 });
  }
}
