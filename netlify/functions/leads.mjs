// Netlify Function: shows saved requests as a simple table.
// Open https://<site>.netlify.app/api/leads?key=<ADMIN_KEY>
// Set ADMIN_KEY in Netlify environment variables (a long random word only you know).
// Without ADMIN_KEY set, this page is switched off.

import { getStore } from "@netlify/blobs";

export const config = { path: "/api/leads" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default async (req) => {
  const adminKey = process.env.ADMIN_KEY;
  const key = new URL(req.url).searchParams.get("key");
  if (!adminKey || key !== adminKey) return new Response("Not found", { status: 404 });

  const store = getStore({ name: "leads", consistency: "strong" });
  const { blobs } = await store.list({ prefix: "lead/" });
  const latest = blobs.map((b) => b.key).sort().reverse().slice(0, 200);
  const leads = await Promise.all(latest.map((k) => store.get(k, { type: "json" })));

  const rows = leads.filter(Boolean).map((l) => `<tr>
    <td>${esc(l.at.replace("T", " ").slice(0, 16))}</td><td>${esc(l.name)}</td><td>${esc(l.phone)}</td>
    <td>${esc(l.service)} × ${esc(l.units)}</td><td>${esc(l.area)}</td><td>${esc(l.date)} ${esc(l.time)}</td>
    <td>${esc(l.note)}</td><td>${l.delivered && l.delivered.length ? esc(l.delivered.join(", ")) : "<b>not sent</b>"}</td></tr>`).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Requests</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#F3F5F7;color:#111}
h1{font-size:20px;margin:0 0 12px}.box{overflow-x:auto;background:#fff;border:1px solid #ddd}
table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
th{background:#111;color:#fff;font-weight:600}</style></head><body>
<h1>Requests (${leads.length})</h1><div class="box"><table><thead><tr><th>Received (UTC)</th><th>Name</th><th>Phone</th><th>Service</th><th>District</th><th>Wanted</th><th>Note</th><th>Sent to</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8">No requests yet.</td></tr>'}</tbody></table></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
};
