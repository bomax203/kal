// Netlify Function: receives the booking form and forwards it to WhatsApp and/or Telegram.
// The visitor stays on the page. Keys live in Netlify environment variables, never in the HTML.
//
// Environment variables (Netlify → Project configuration → Environment variables):
//   WA_PHONE    – WhatsApp number that receives requests, e.g. +380962305635
//   WA_APIKEY   – CallMeBot key for that number (free, personal use only — fine for testing)
//   TG_TOKEN    – Telegram bot token from @BotFather (optional)
//   TG_CHAT_ID  – Telegram chat id (optional)

export const config = { path: "/api/lead" };

const clean = (v, max) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, max);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  let d;
  try { d = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  if (d.company) return json({ ok: true }); // honeypot

  const name = clean(d.name, 80);
  const phone = clean(d.phone, 30);
  if (!name || phone.replace(/\D/g, "").length < 9) return json({ ok: false, error: "invalid" }, 400);

  const text = [
    "New AC booking from the website",
    `Service: ${clean(d.service, 60)} x ${clean(d.units, 3)}`,
    `Name: ${name}`,
    `Phone: ${phone}`,
    `District: ${clean(d.area, 60) || "-"}`,
    `When: ${clean(d.date, 20) || "-"} ${clean(d.time, 10)}`,
    `Note: ${clean(d.note, 800) || "-"}`,
  ].join("\n");

  const env = process.env;
  const jobs = [];
  const names = [];

  if (env.WA_PHONE && env.WA_APIKEY) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(env.WA_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(env.WA_APIKEY)}`;
    jobs.push(fetch(url)); names.push("whatsapp");
  }
  if (env.TG_TOKEN && env.TG_CHAT_ID) {
    jobs.push(fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
    })); names.push("telegram");
  }

  if (!jobs.length) {
    console.error("lead: no channel configured — set WA_PHONE + WA_APIKEY or TG_TOKEN + TG_CHAT_ID");
    return json({ ok: false, error: "no channel configured" }, 500);
  }

  const results = await Promise.allSettled(jobs);
  let delivered = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      const body = await r.value.text().catch(() => "");
      // CallMeBot answers 200 even on some errors, so check the text too
      const failed = !r.value.ok || /error|invalid|apikey/i.test(body) && !/queued|sent/i.test(body);
      console.log(`lead: ${names[i]} -> ${r.value.status} ${body.replace(/<[^>]+>/g, " ").slice(0, 200)}`);
      if (!failed) delivered = true;
    } else {
      console.error(`lead: ${names[i]} failed`, r.reason);
    }
  }
  return delivered ? json({ ok: true }) : json({ ok: false, error: "delivery failed" }, 502);
};
