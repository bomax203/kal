// Netlify Function: cancel a booking and free its time slot.
//
// Client (private link from the confirmation screen):
//   GET  /api/cancel?t=<token>          -> {"date","time","service","status"}
//   POST /api/cancel  {"t":"<token>"}   -> cancels if the visit has not started yet
//
// Owner (button on /api/leads):
//   POST /api/cancel  form fields key=<ADMIN_KEY>&lead=<lead key>  -> cancels, then back to the list

import { leadsStore, json, cancelLead, isPast, sameSecret } from "../lib/shared.mjs";

export const config = { path: "/api/cancel" };

const TOKEN = /^[a-f0-9]{32}$/;

async function leadByToken(store, t) {
  if (!TOKEN.test(t || "")) return null;
  const ref = await store.get(`token/${t}`, { type: "json" });
  if (!ref) return null;
  const lead = await store.get(ref.leadKey, { type: "json" });
  return lead ? { leadKey: ref.leadKey, lead } : null;
}

export default async (req) => {
  const store = leadsStore();

  if (req.method === "GET") {
    const found = await leadByToken(store, new URL(req.url).searchParams.get("t"));
    if (!found) return json({ ok: false, error: "not_found" }, 404);
    const { lead } = found;
    return json({ ok: true, date: lead.date, time: lead.time, service: lead.service, units: lead.units, status: lead.status || "booked" });
  }

  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  const type = req.headers.get("content-type") || "";

  // owner: HTML form from the requests page
  if (type.includes("application/x-www-form-urlencoded")) {
    const f = new URLSearchParams(await req.text());
    const key = f.get("key");
    if (!sameSecret(key, process.env.ADMIN_KEY)) return new Response("Not found", { status: 404 });
    const leadKey = f.get("lead") || "";
    if (!/^lead\/\d+-[a-z0-9]+$/.test(leadKey)) return new Response("Bad request", { status: 400 });
    await cancelLead(store, leadKey, "owner");
    return new Response(null, { status: 303, headers: { Location: `/api/leads?key=${encodeURIComponent(key)}` } });
  }

  // client: JSON with the private token
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const found = await leadByToken(store, body.t);
  if (!found) return json({ ok: false, error: "not_found" }, 404);
  if (found.lead.status === "cancelled") return json({ ok: true, already: true });
  if (isPast(found.lead.date, found.lead.time)) return json({ ok: false, error: "too_late" }, 400);

  const r = await cancelLead(store, found.leadKey, "client");
  return r.ok ? json({ ok: true }) : json({ ok: false, error: r.error }, 400);
};
