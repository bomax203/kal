// Netlify Function: tells the booking form which times are already taken on a date.
// GET /api/slots?date=YYYY-MM-DD  ->  {"taken":["09:00","16:00"]}
// Returns only times — never names or phone numbers.

import { getStore } from "@netlify/blobs";

export const config = { path: "/api/slots" };

export default async (req) => {
  const date = new URL(req.url).searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ taken: [] }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const store = getStore({ name: "leads", consistency: "strong" });
  const { blobs } = await store.list({ prefix: `slot/${date}/` });
  const taken = blobs.map((b) => b.key.split("/").pop()).sort();
  return new Response(JSON.stringify({ taken }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
