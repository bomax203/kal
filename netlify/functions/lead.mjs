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
//   lead/<timestamp>-<id>     – every request
//   slot/<YYYY-MM-DD>/<HH:MM> – booked time slot (one client per slot)

import { getStore } from "@netlify/blobs";

export const config = { path: "/api/lead" };

// Working hours — keep in sync with HOURS in index.html.
// Mon–Fri 9:00–18:00, Sat 9:00–14:00, Sunday closed; slots every 30 min, last start 30 min before closing.
const OPEN = { 0: null, 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 18], 5: [9, 18], 6: [9, 14] };
const DAYS_AHEAD = 60;

// current date and time in Varna (Europe/Sofia)
function sofiaNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function isBookable(date, time) {
  const day = new Date(`${date}T12:00:00Z`);
  if (isNaN(day)) return false;
  const hours = OPEN[day.getUTCDay()];
  if (!hours) return false;
  const [h, m] = time.split(":").map(Number);
  if (!(m === 0 || m === 30) || h < hours[0] || h >= hours[1]) return false;
  const now = sofiaNow();
  if (date < now.date || (date === now.date && time <= now.time)) return false;
  const limit = new Date(`${now.date}T12:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + DAYS_AHEAD);
  return day <= limit;
}

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

  const date = clean(d.date, 10);
  const time = clean(d.time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return json({ ok: false, error: "date/time" }, 400);
  }
  if (!isBookable(date, time)) return json({ ok: false, error: "closed" }, 400);

  const store = getStore({ name: "leads", consistency: "strong" });
  const now = Date.now();
  const phone9 = digits.slice(-9); // +359 88… and 088… count as the same number

  // one client per time slot
  const slotKey = `slot/${date}/${time}`;
  const slot = await store.get(slotKey, { type: "json" }).catch(() => null);
  if (slot) {
    if (slot.phone9 === phone9) {
      console.log(`lead: same client re-sent ${date} ${time}, skipped`);
      return json({ ok: true, duplicate: true });
    }
    console.log(`lead: slot ${date} ${time} already taken`);
    return json({ ok: false, error: "slot_taken" }, 409);
  }
  // reserve the slot before sending, so a second request a moment later sees it as taken
  await store.setJSON(slotKey, { phone9, at: now });

  const lead = {
    at: new Date(now).toISOString(),
    service: clean(d.service, 60),
    units: clean(d.units, 3),
    name,
    phone,
    area: clean(d.area, 60),
    date,
    time,
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

  return result.ok ? json({ ok: true }) : json({ ok: false, error: "delivery failed", saved: true }, 502);
};
