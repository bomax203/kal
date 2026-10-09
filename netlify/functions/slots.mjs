// Netlify Function: tells the booking calendar which times are already taken.
// GET /api/slots?from=YYYY-MM-DD&to=YYYY-MM-DD -> {"booked":{"2026-10-12":["09:00","16:00"]}}
// GET /api/slots?date=YYYY-MM-DD               -> {"taken":["09:00","16:00"]}
// Returns only dates and times — never names or phone numbers.

import { leadsStore, json } from "../lib/shared.mjs";

export const config = { path: "/api/slots" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const store = leadsStore();

  const date = q.get("date");
  if (date) {
    if (!DAY.test(date)) return json({ taken: [] }, 400);
    const { blobs } = await store.list({ prefix: `slot/${date}/` });
    return json({ taken: blobs.map((b) => b.key.split("/").pop()).sort() });
  }

  const from = q.get("from") || "";
  const to = q.get("to") || "";
  if (!DAY.test(from) || !DAY.test(to)) return json({ booked: {} }, 400);

  const { blobs } = await store.list({ prefix: "slot/" });
  const booked = {};
  for (const b of blobs) {
    const [, day, time] = b.key.split("/");
    if (day >= from && day <= to) (booked[day] ||= []).push(time);
  }
  for (const k in booked) booked[k].sort();
  return json({ booked });
};
