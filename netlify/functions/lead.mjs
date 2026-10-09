// Netlify Function: receives the form from the site and forwards it to Telegram and/or WhatsApp.
// The visitor never leaves the page. Keys live in Netlify environment variables, never in the HTML.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   TG_TOKEN    – Telegram bot token from @BotFather            (recommended, free, allowed for business)
//   TG_CHAT_ID  – chat id where requests should arrive
//   WA_PHONE    – WhatsApp number, e.g. +359880000000            (optional, see README)
//   WA_APIKEY   – CallMeBot key for that number                  (optional, personal use only)

export const config = { path: "/api/lead" };

const clean = (v, max) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, max);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  let d;
  try { d = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  if (d.company) return json({ ok: true }); // honeypot: bots fill the hidden field

  const name = clean(d.name, 80);
  const phone = clean(d.phone, 30);
  if (!name || phone.replace(/\D/g, "").length < 9) return json({ ok: false, error: "invalid" }, 400);

  const items = Array.isArray(d.items) ? d.items.map((i) => clean(i, 40)).slice(0, 10) : [];
  const lines = [
    "New request from the website",
    `Type: ${clean(d.need, 40)}`,
    `Items: ${items.join(", ") || "-"}`,
    `Name: ${name}`,
    `Phone: ${phone}`,
    `District: ${clean(d.area, 60) || "-"}`,
    `Date: ${clean(d.date, 20) || "-"}`,
    `Note: ${clean(d.note, 800) || "-"}`,
  ];
  const text = lines.join("\n");

  const env = process.env;
  const jobs = [];

  // Telegram (text, or photo with caption)
  if (env.TG_TOKEN && env.TG_CHAT_ID) {
    const base = `https://api.telegram.org/bot${env.TG_TOKEN}`;
    const photo = typeof d.photo === "string" && d.photo.startsWith("data:image/jpeg;base64,") ? d.photo : null;
    if (photo && photo.length < 5_000_000) {
      const bytes = Buffer.from(photo.split(",")[1], "base64");
      const fd = new FormData();
      fd.append("chat_id", env.TG_CHAT_ID);
      fd.append("caption", text.slice(0, 1000));
      fd.append("photo", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
      jobs.push(fetch(`${base}/sendPhoto`, { method: "POST", body: fd }));
    } else {
      jobs.push(fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text }),
      }));
    }
  }

  // WhatsApp via CallMeBot (text only)
  if (env.WA_PHONE && env.WA_APIKEY) {
    const wa = (d.photo ? text + "\n(Photo attached — see Telegram)" : text);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(env.WA_PHONE)}&text=${encodeURIComponent(wa)}&apikey=${encodeURIComponent(env.WA_APIKEY)}`;
    jobs.push(fetch(url));
  }

  if (!jobs.length) return json({ ok: false, error: "no channel configured" }, 500);

  const results = await Promise.allSettled(jobs);
  const delivered = results.some((r) => r.status === "fulfilled" && r.value.ok);
  return delivered ? json({ ok: true }) : json({ ok: false, error: "delivery failed" }, 502);
};
