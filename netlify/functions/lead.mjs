// Netlify Function: receives the booking form, reserves the time slot, saves the request
// and notifies the owner (WhatsApp and/or Telegram). The visitor stays on the page.
//
// Environment variables (Netlify → Project configuration → Environment variables):
//   WA_PHONE / WA_APIKEY   – WhatsApp via CallMeBot (free, personal use only — fine for the demo)
//   TG_TOKEN / TG_CHAT_ID  – Telegram bot (optional)
//
// Storage: Netlify Blobs, store "leads":
//   lead/<timestamp>-<id>      – every request
//   slot/<YYYY-MM-DD>/<HH:MM>  – booked time slot (one client per slot)
//   token/<token>              – private cancel link for the client

import { randomBytes } from "node:crypto";
import { leadsStore, clean, json, isBookable, notifyOwner, normLang } from "../lib/shared.mjs";

export const config = { path: "/api/lead" };

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

  const store = leadsStore();
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

  const leadKey = `lead/${now}-${randomBytes(3).toString("hex")}`;
  const token = randomBytes(16).toString("hex");

  // reserve the slot before sending, so a second request a moment later sees it as taken
  await store.setJSON(slotKey, { phone9, at: now, leadKey });

  const lead = {
    at: new Date(now).toISOString(),
    status: "booked",
    service: clean(d.service, 60),
    units: clean(d.units, 3),
    name,
    phone,
    area: clean(d.area, 60),
    date,
    time,
    note: clean(d.note, 800),
    lang: normLang(d.lang), // client's language: bg / ru / en
    slotKey,
  };

  const result = await notifyOwner([
    "New AC booking from the website",
    `When: ${date} ${time}`,
    `Service: ${lead.service} x ${lead.units}`,
    `Name: ${name}`,
    `Phone: ${phone}`,
    `District: ${lead.area || "-"}`,
    `Note: ${lead.note || "-"}`,
    `Client language: ${lead.lang.toUpperCase()} (reply in this language)`,
  ].join("\n"));
  lead.delivered = result.channels;

  // save the request even if delivery failed, so nothing is lost
  await store.setJSON(leadKey, lead);
  await store.setJSON(`token/${token}`, { leadKey });

  const cancel = `/cancel.html?t=${token}`;
  return result.ok ? json({ ok: true, cancel }) : json({ ok: false, error: "delivery failed", saved: true }, 502);
};
