// Shared helpers for the booking functions.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

export const leadsStore = () => getStore({ name: "leads", consistency: "strong" });

export const clean = (v, max) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, max);
export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---- working hours (keep in sync with HOURS in index.html) ----
// Mon–Fri 9:00–18:00, Sat 9:00–14:00, Sunday closed; slots every 30 min, last start 30 min before closing.
export const OPEN = { 0: null, 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 18], 5: [9, 18], 6: [9, 14] };
export const DAYS_AHEAD = 60;

// current date and time in Varna (Europe/Sofia)
export function sofiaNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function isPast(date, time) {
  const now = sofiaNow();
  return date < now.date || (date === now.date && time <= now.time);
}

export function isBookable(date, time) {
  const day = new Date(`${date}T12:00:00Z`);
  if (isNaN(day)) return false;
  const hours = OPEN[day.getUTCDay()];
  if (!hours) return false;
  const [h, m] = time.split(":").map(Number);
  if (!(m === 0 || m === 30) || h < hours[0] || h >= hours[1]) return false;
  if (isPast(date, time)) return false;
  const limit = new Date(`${sofiaNow().date}T12:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + DAYS_AHEAD);
  return day <= limit;
}

// constant-time comparison for the admin key
export function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- notifications to the owner (WhatsApp via CallMeBot and/or Telegram) ----
export async function notifyOwner(text) {
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
    console.error("notify: no channel configured — set WA_PHONE + WA_APIKEY or TG_TOKEN + TG_CHAT_ID");
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
      console.log(`notify: ${names[i]} -> ${r.value.status} ${body.replace(/<[^>]+>/g, " ").slice(0, 200)}`);
      if (!failed) delivered.push(names[i]);
    } else {
      console.error(`notify: ${names[i]} failed`, r.reason);
    }
  }
  return { ok: delivered.length > 0, channels: delivered };
}

// ---- cancel one booking: frees the time slot and marks the request as cancelled ----
export async function cancelLead(store, leadKey, by) {
  const lead = await store.get(leadKey, { type: "json" });
  if (!lead) return { ok: false, error: "not_found" };
  if (lead.status === "cancelled") return { ok: true, already: true, lead };

  const slotKey = lead.slotKey || `slot/${lead.date}/${lead.time}`;
  const slot = await store.get(slotKey, { type: "json" }).catch(() => null);
  // free the slot only if it still belongs to this booking
  if (slot && (!slot.leadKey || slot.leadKey === leadKey)) await store.delete(slotKey);

  lead.status = "cancelled";
  lead.cancelledAt = new Date().toISOString();
  lead.cancelledBy = by;
  await store.setJSON(leadKey, lead);

  await notifyOwner([
    `Booking CANCELLED (by ${by})`,
    `When: ${lead.date} ${lead.time}`,
    `Service: ${lead.service} x ${lead.units}`,
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    "The time is free again on the website.",
  ].join("\n")).catch(() => {});

  return { ok: true, lead };
}
