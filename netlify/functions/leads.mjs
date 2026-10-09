// Netlify Function: the owner's list of requests.
// - cancel a booking (frees the time slot)
// - one tap to message the client in THEIR language (bg / ru / en):
//   WhatsApp opens with a ready text; for Viber the text is copied, then the chat opens.
// Open https://<site>.netlify.app/api/leads?key=<ADMIN_KEY>
// Set ADMIN_KEY in Netlify environment variables (a long word only you know).
// Without ADMIN_KEY set, this page is switched off.

import { leadsStore, sameSecret, isPast, clientMessage, normLang } from "../lib/shared.mjs";

export const config = { path: "/api/leads" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// phone in international digits for WhatsApp/Viber links: 088… -> 35988…, +380… -> 380…
function intl(phone) {
  const raw = String(phone || "").trim();
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (!raw.startsWith("+") && d.startsWith("0")) d = "359" + d.slice(1); // local Bulgarian number
  return d;
}

function contactButtons(l, status) {
  const n = intl(l.phone);
  if (n.length < 9) return "";
  const kind = status === "cancelled" ? "cancelled" : "confirm";
  const text = clientMessage(l, kind);
  const wa = `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
  const vb = `viber://chat?number=%2B${n}`;
  const label = kind === "cancelled" ? "Tell client: cancelled" : "Confirm to client";
  return `<div class="msg">
    <a class="wa" href="${wa}" target="_blank" rel="noopener">WhatsApp: ${label}</a>
    <a class="vb" href="${vb}" data-text="${esc(text)}" onclick="return viber(this)">Viber (copies text)</a>
  </div>`;
}

export default async (req) => {
  const adminKey = process.env.ADMIN_KEY;
  const key = new URL(req.url).searchParams.get("key");
  if (!sameSecret(key, adminKey)) return new Response("Not found", { status: 404 });

  const store = leadsStore();
  const { blobs } = await store.list({ prefix: "lead/" });
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, 300);
  const leads = (await Promise.all(keys.map(async (k) => ({ k, l: await store.get(k, { type: "json" }) })))).filter((x) => x.l);

  const upcoming = leads.filter(({ l }) => (l.status || "booked") === "booked" && l.date && !isPast(l.date, l.time)).length;

  const rows = leads.map(({ k, l }) => {
    const status = l.status || "booked";
    const canCancel = status === "booked" && l.date && !isPast(l.date, l.time);
    const statusCell = status === "cancelled"
      ? `<span class="st off">Cancelled${l.cancelledBy ? " by " + esc(l.cancelledBy) : ""}</span>`
      : canCancel ? '<span class="st on">Booked</span>' : '<span class="st past">Done / past</span>';
    const action = canCancel
      ? `<form method="post" action="/api/cancel" onsubmit="return confirmCancel(this)">
           <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="lead" value="${esc(k)}">
           <button type="submit">Cancel &amp; free time</button></form>`
      : "";
    const contact = status === "cancelled" || canCancel ? contactButtons(l, status) : "";
    return `<tr class="${status === "cancelled" ? "cx" : ""}">
      <td><b>${esc(l.date)} ${esc(l.time)}</b></td><td>${esc(l.name)}</td><td>${esc(l.phone)}</td>
      <td><span class="lang">${esc(normLang(l.lang).toUpperCase())}</span></td>
      <td>${esc(l.service)} × ${esc(l.units)}</td><td>${esc(l.area)}</td><td>${esc(l.note)}</td>
      <td>${statusCell}</td><td>${l.delivered && l.delivered.length ? esc(l.delivered.join(", ")) : "<b>not sent</b>"}</td>
      <td>${esc((l.at || "").replace("T", " ").slice(0, 16))}</td>
      <td>${action}${contact}</td></tr>`;
  }).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Requests</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#F3F5F7;color:#111}
h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 14px;color:#555}
.box{overflow-x:auto;background:#fff;border:1px solid #ddd}
table{border-collapse:collapse;width:100%;min-width:1080px}
th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
th{background:#111;color:#fff;font-weight:600;white-space:nowrap}
tr.cx td{color:#888}
.st{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.st.on{background:#DFF3E7;color:#1D6B43}.st.off{background:#F7E1DC;color:#9A3A28}.st.past{background:#ECECEC;color:#555}
.lang{display:inline-block;padding:2px 6px;border:1px solid #bbb;border-radius:4px;font-size:12px;font-weight:700}
button{min-height:36px;padding:0 12px;border:1px solid #9A3A28;background:#fff;color:#9A3A28;font-weight:600;cursor:pointer;white-space:nowrap}
button:hover{background:#9A3A28;color:#fff}
.msg{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.msg a{display:inline-flex;align-items:center;min-height:36px;padding:0 10px;font-weight:600;text-decoration:none;white-space:nowrap;border-radius:4px}
.msg .wa{background:#1F8F4E;color:#fff}.msg .vb{background:#6F4FC9;color:#fff}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:6px;display:none}
</style>
<script>
function confirmCancel(f){var b=f.querySelector('button');if(b.dataset.sure){return true;}b.dataset.sure='1';b.textContent='Tap again to confirm';setTimeout(function(){b.dataset.sure='';b.textContent='Cancel & free time';},4000);return false;}
function toast(t){var e=document.getElementById('toast');e.textContent=t;e.style.display='block';setTimeout(function(){e.style.display='none';},2500);}
function viber(a){
  var text=a.getAttribute('data-text'),go=function(){location.href=a.getAttribute('href');};
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){toast('Text copied \\u2014 paste it in Viber');setTimeout(go,600);},function(){window.prompt('Copy this text:',text);go();});
  }else{window.prompt('Copy this text:',text);go();}
  return false;
}
</script>
</head><body>
<h1>Requests (${leads.length})</h1><p class="sub">${upcoming} upcoming booking(s). Times are Varna time. Messages to clients open in the client's language.</p>
<div class="box"><table><thead><tr><th>Visit</th><th>Name</th><th>Phone</th><th>Lang</th><th>Service</th><th>District</th><th>Note</th><th>Status</th><th>Sent to</th><th>Received (UTC)</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="11">No requests yet.</td></tr>'}</tbody></table></div><div id="toast" role="status"></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
};
