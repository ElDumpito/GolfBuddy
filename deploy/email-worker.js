// GolfHomie email worker (Cloudflare Email Routing → this Worker → GolfHomie).
// Receives mail sent to bookings@juno.nexus and hands the whole message to GolfHomie, which reads
// tee-time confirmations and cancellations out of it.
//
// Settings on the Worker (Settings › Variables):
//   GOLFHOMIE_URL  = https://golf.juno.nexus
//   INBOUND_KEY    = the key from GolfHomie › Me › Admin › Bookings by email (add it as a Secret)
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).text();
    const res = await fetch(`${env.GOLFHOMIE_URL}/api/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Inbound-Key': env.INBOUND_KEY },
      body: JSON.stringify({ from: message.from, to: message.to, raw }),
    });
    // A refused key or an app that's down bounces the email, so you find out.
    if (res.status === 403 || res.status >= 500) message.setReject(`GolfHomie could not take this email (${res.status}).`);
  },
};
