// Netlify Function: receives the booking form, saves it, skips duplicates,
// and forwards new requests to WhatsApp and/or Telegram. The visitor stays on the page.
//
// Environment variables (Netlify → Project configuration → Environment variables):
//   WA_PHONE    – WhatsApp number that receives requests, e.g. +359878413468
//   WA_APIKEY   – CallMeBot key for that number (free, personal use only — fine for the demo)
//   TG_TOKEN    – Telegram bot token from @BotFather (optional)
//   TG_CHAT_ID  – Telegram chat id (optional)
//
// Storage: Netlify Blobs, store "leads" (built in, no setup).
//   lead/<timestamp>-<id>  – every request
//   phone/<digits>         – last time this phone sent a request (for duplicate check)

import { getStore } from "@netlify/blobs";

export const config = { path: "/api/lead" };

const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000; // same phone within 24 h = duplicate

const clean = (v, max) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, max);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function deliver(text) {
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
    return { ok: false, channels: [] };
  }

  const results = await Promise.allSettled(jobs);
  const delivered = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      const body = await r.value.text().catch(() => "");
      // CallMeBot can answer 200 with an error text, so check the body too
      const failed = !r.value.ok || (/error|invalid|apikey/i.test(body) && !/queued|sent/i.test(body));
      console.log(`lead: ${names[i]} -> ${r.value.status} ${body.replace(/<[^>]+>/g, " ").slice(0, 200)}`);
      if (!failed) delivered.push(names[i]);
    } else {
      console.error(`lead: ${names[i]} failed`, r.reason);
    }
  }
  return { ok: delivered.length > 0, channels: delivered };
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  let d;
  try { d = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  if (d.company) return json({ ok: true }); // honeypot: bots fill the hidden field

  const name = clean(d.name, 80);
  const phone = clean(d.phone, 30);
  const digits = phone.replace(/\D/g, "");
  if (!name || digits.length < 9) return json({ ok: false, error: "invalid" }, 400);

  const store = getStore({ name: "leads", consistency: "strong" });
  const now = Date.now();

  // duplicate check: same phone number within the window
  // (compare the last 9 digits so +359 88… and 088… count as the same number)
  const phoneKey = `phone/${digits.slice(-9)}`;
  const last = await store.get(phoneKey, { type: "json" }).catch(() => null);
  if (last && now - last.at < DUPLICATE_WINDOW_MS) {
    console.log(`lead: duplicate from …${digits.slice(-4)}, skipped`);
    return json({ ok: true, duplicate: true });
  }

  const lead = {
    at: new Date(now).toISOString(),
    service: clean(d.service, 60),
    units: clean(d.units, 3),
    name,
    phone,
    area: clean(d.area, 60),
    date: clean(d.date, 20),
    time: clean(d.time, 10),
    note: clean(d.note, 800),
  };

  const text = [
    "New AC booking from the website",
    `Service: ${lead.service} x ${lead.units}`,
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    `District: ${lead.area || "-"}`,
    `When: ${lead.date || "-"} ${lead.time}`,
    `Note: ${lead.note || "-"}`,
  ].join("\n");

  const result = await deliver(text);
  lead.delivered = result.channels;

  // save the request even if delivery failed, so nothing is lost
  const id = Math.random().toString(36).slice(2, 8);
  await store.setJSON(`lead/${now}-${id}`, lead);
  if (result.ok) await store.setJSON(phoneKey, { at: now });

  return result.ok ? json({ ok: true }) : json({ ok: false, error: "delivery failed", saved: true }, 502);
};
