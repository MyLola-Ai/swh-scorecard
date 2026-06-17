#!/usr/bin/env node
/**
 * Build the SWH Help Center page (help.html) for the Scorecard and CRM.
 *
 * Source content: help-content.json (the SWH help articles, mirrored from
 * the LoanIQ docs pipeline). Self-contained output (articles inlined, no
 * fetch / Firestore / auth) so it works on web AND inside the Capacitor
 * iOS shell. Written to BOTH hosting targets:
 *   public-scorecard/help.html  (app.stopwastinghandshakes.com/help.html)
 *   public-crm/help.html        (crm.stopwastinghandshakes.com/help.html)
 *
 * Regenerate after editing help-content.json:  node build-help.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = '/Users/austen/swh-scoreboard';
const LOANIQ_DIR = '/Users/austen/loaniq/docs/help-center/articles';
const CONTENT = `${ROOT}/help-content.json`;

// The SWH help is SWH's own 16 guides PLUS the MyAppointment booking guides.
// myappointment.ai is the booking backend the SWH CRM's Appointments screen
// uses, so those guides "cross over" into SWH. We pull the host/booker guides
// (not the platform-admin console) and group them under one clear section.
const APPT_INCLUDE = new Set([
  'find-your-booking-link', 'host-booking-hub-public',
  'book-a-meeting-public', 'manage-booking-pages-dashboard',
]);
function loadArticles() {
  const swh = JSON.parse(readFileSync(`${LOANIQ_DIR}/swh.json`, 'utf8'));
  // SWH gap-fill articles authored from the coverage deep-dive (Coaching, etc.).
  const extraPath = `${LOANIQ_DIR}/swh-extra.json`;
  const extra = existsSync(extraPath) ? JSON.parse(readFileSync(extraPath, 'utf8')) : [];
  const appt = JSON.parse(readFileSync(`${LOANIQ_DIR}/myappointment.json`, 'utf8'))
    .filter((a) => APPT_INCLUDE.has(a.id))
    .map((a) => ({ ...a, category: 'Appointments & Booking' }));
  return [...swh, ...extra, ...appt];
}

// Build from the docs pipeline when available, snapshotting the merged set to
// help-content.json so the SWH repo stays self-contained. Otherwise reuse the
// snapshot already in the repo.
let articles;
if (existsSync(`${LOANIQ_DIR}/swh.json`)) {
  articles = loadArticles();
  writeFileSync(CONTENT, JSON.stringify(articles, null, 2));
} else {
  articles = JSON.parse(readFileSync(CONTENT, 'utf8'));
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>SWH Help</title>
<link rel="icon" href="favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@700;800;900&display=swap" rel="stylesheet">
<style>
  :root{
    --navy:#1a1a1a; --gold:#E63946; --gold-light:#f25862;
    --bg:#EBEBEC; --card:#FFFFFF; --text:#1a1a1a; --text-muted:#6B7280;
    --text-soft:#9AA0A6; --border:#E4E4E7; --radius:16px;
    --green:#5A8A6A;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;}
  body{font-family:'DM Sans',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;
    padding-top:env(safe-area-inset-top); padding-bottom:env(safe-area-inset-bottom);}
  .disp{font-family:'Playfair Display',Georgia,serif;}
  .wrap{max-width:640px;margin:0 auto;padding:18px 16px 72px;}
  a{color:inherit;}
  .back{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted);text-decoration:none;font-size:13px;font-weight:600;border:none;background:none;cursor:pointer;padding:0;font-family:inherit;}
  .kicker{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);margin:14px 0 4px;}
  h1.disp{font-size:30px;font-weight:900;margin:0 0 4px;line-height:1.1;}
  .lead{color:var(--text-muted);font-size:14px;line-height:1.6;margin:0 0 18px;}
  .search{width:100%;padding:13px 16px;border-radius:14px;border:1.5px solid var(--border);font-size:15px;font-family:inherit;background:var(--card);outline:none;}
  .search:focus{border-color:var(--gold);}
  .sectlabel{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--text-soft);margin:22px 0 8px;}
  .cats{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  @media(max-width:430px){.cats{grid-template-columns:1fr;}}
  .cat{background:var(--card);border:1.5px solid var(--border);border-radius:var(--radius);padding:14px 15px;text-align:left;cursor:pointer;font-family:inherit;transition:border-color .12s,transform .12s;}
  .cat:active{transform:scale(.99);}
  .cat .n{display:flex;justify-content:space-between;align-items:baseline;}
  .cat .t{font-size:14.5px;font-weight:700;}
  .cat .c{font-size:12px;color:var(--text-soft);}
  .row{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--card);border:1.5px solid var(--border);border-radius:14px;padding:13px 15px;cursor:pointer;font-family:inherit;text-align:left;width:100%;margin-bottom:8px;transition:border-color .12s;}
  .row:hover{border-color:var(--gold-light);}
  .row > span:first-child{min-width:0;}
  .row .t{display:block;font-size:14px;font-weight:700;color:var(--text);}
  .row .s{display:block;font-size:12.5px;color:var(--text-muted);margin-top:3px;line-height:1.45;}
  .row .meta{display:block;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft);margin-top:6px;}
  .row .arr{color:var(--gold);font-size:18px;font-weight:800;flex-shrink:0;}
  .badge{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;background:var(--gold);color:#fff;}
  .badge.sub{background:rgba(0,0,0,.06);color:var(--text-muted);}
  .badges{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin:12px 0 0;}
  h2.disp{font-size:23px;font-weight:900;margin:10px 0 6px;line-height:1.15;}
  .a-summary{color:var(--text-muted);font-size:14.5px;line-height:1.6;margin:0 0 18px;}
  .sec{margin-top:20px;}
  .sec h3{font-size:11.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--text-soft);margin:0 0 10px;}
  .def{display:flex;gap:10px;margin-bottom:8px;}
  .def .k{flex-shrink:0;width:96px;font-size:12px;font-weight:700;color:var(--text-soft);}
  .def .v{font-size:13.5px;line-height:1.6;}
  ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:16px;}
  .step{display:flex;gap:12px;align-items:flex-start;}
  .num{flex-shrink:0;width:25px;height:25px;border-radius:999px;background:var(--gold);color:#fff;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;}
  .step .st{font-size:14.5px;font-weight:700;}
  .step .sb{font-size:13.5px;color:var(--text-muted);line-height:1.6;margin-top:3px;}
  ul.bul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;}
  ul.bul li{font-size:13.5px;color:var(--text-muted);line-height:1.6;}
  .tcard{background:var(--card);border:1.5px solid var(--border);border-radius:14px;padding:13px 15px;margin-bottom:10px;}
  .tcard .tp{font-size:13.5px;font-weight:700;}
  .tcard .tl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-soft);margin-top:7px;}
  .tcard .fx{font-size:13px;line-height:1.6;margin-top:8px;}
  .tcard .fx b{font-weight:700;}
  details.faq{background:var(--card);border:1.5px solid var(--border);border-radius:13px;padding:12px 14px;margin-bottom:9px;}
  details.faq summary{cursor:pointer;font-size:13.5px;font-weight:700;list-style:none;}
  details.faq summary::-webkit-details-marker{display:none;}
  details.faq p{margin:8px 0 0;font-size:13px;color:var(--text-muted);line-height:1.6;}
  .empty{background:var(--card);border:1.5px solid var(--border);border-radius:14px;padding:18px;color:var(--text-muted);font-size:13.5px;}
  .footer{margin-top:34px;border-top:1px solid var(--border);padding-top:18px;color:var(--text-soft);font-size:12.5px;line-height:1.6;}
</style>
</head>
<body>
<div class="wrap">
  <button class="back" id="backBtn">&larr; Back to SWH</button>
  <div class="kicker">SWH Help</div>
  <h1 class="disp">How can we help?</h1>
  <p class="lead">Guides for the Scorecard, the Pro CRM, and your booking pages. Search, or browse by topic. <span id="count"></span></p>
  <input class="search" id="q" type="search" placeholder="Search: points, wasted handshakes, FORM, reminders…" aria-label="Search help">
  <div id="view"></div>
  <div class="footer">
    Still stuck? Email <a href="mailto:austen@stopwastinghandshakes.com">austen@stopwastinghandshakes.com</a>.
  </div>
</div>

<script>
const ARTICLES = ${JSON.stringify(articles)};
const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const view = document.getElementById('view');
const qEl = document.getElementById('q');
document.getElementById('count').textContent = ARTICLES.length + ' guides.';

function hay(a){
  return [a.title,a.summary,a.category,(a.keywords||[]).join(' '),
    (a.overview?[a.overview.what,a.overview.why,a.overview.who].join(' '):''),
    (a.troubleshooting||[]).map(t=>t.problem).join(' '),
    (a.faqs||[]).map(f=>f.q).join(' '),
    (a.steps||[]).map(s=>s.title).join(' ')].join(' \\n ').toLowerCase();
}
function search(q){
  q=q.trim().toLowerCase(); if(!q) return [];
  const terms=q.split(/\\s+/).filter(Boolean);
  return ARTICLES.map(a=>{
    const h=hay(a), t=a.title.toLowerCase(); let sc=0;
    if(t.includes(q))sc+=100; if(h.includes(q))sc+=20;
    for(const tm of terms){ if(t.includes(tm))sc+=12; if((a.keywords||[]).some(k=>k.toLowerCase().includes(tm)))sc+=8; if(h.includes(tm))sc+=2; }
    return {a,sc};
  }).filter(x=>x.sc>0).sort((x,y)=>y.sc-x.sc).map(x=>x.a);
}
function rowHTML(a,showCat){
  return '<button class="row" data-id="'+esc(a.id)+'"><span><span class="t">'+esc(a.title)+'</span>'+
    '<span class="s">'+esc(a.summary||'')+'</span>'+
    (showCat?'<span class="meta">'+esc(a.category||'')+'</span>':'')+
    '</span><span class="arr">&rarr;</span></button>';
}
function renderHome(){
  const cats={}; for(const a of ARTICLES){ (cats[a.category]=cats[a.category]||[]).push(a); }
  const order=Object.keys(cats).sort();
  let h='<div class="sectlabel">Browse by topic</div><div class="cats">';
  for(const c of order){ h+='<button class="cat" data-cat="'+esc(c)+'"><span class="n"><span class="t">'+esc(c)+'</span><span class="c">'+cats[c].length+'</span></span></button>'; }
  h+='</div>';
  h+='<div class="sectlabel">All guides</div>';
  for(const c of order){ h+='<div class="sectlabel" style="color:var(--gold);margin-top:14px;">'+esc(c)+'</div>'; for(const a of cats[c]) h+=rowHTML(a,false); }
  view.innerHTML=h;
}
function renderResults(q){
  const r=search(q);
  if(!r.length){ view.innerHTML='<div class="empty">No results for &ldquo;'+esc(q)+'&rdquo;. Try a shorter term, or email support below.</div>'; return; }
  view.innerHTML='<div class="sectlabel">'+r.length+' result'+(r.length===1?'':'s')+'</div>'+r.map(a=>rowHTML(a,true)).join('');
}
function renderCat(cat){
  const r=ARTICLES.filter(a=>a.category===cat);
  view.innerHTML='<button class="back" id="catBack" style="margin-bottom:10px;">&larr; All topics</button><div class="sectlabel" style="color:var(--gold);">'+esc(cat)+'</div>'+r.map(a=>rowHTML(a,false)).join('');
  document.getElementById('catBack').onclick=()=>{ qEl.value=''; renderHome(); };
}
function renderArticle(id){
  const a=ARTICLES.find(x=>x.id===id); if(!a){ renderHome(); return; }
  let h='<button class="back" id="aBack" style="margin-bottom:6px;">&larr; All help</button>';
  h+='<div class="badges"><span class="badge">SWH</span><span class="badge sub">'+esc(a.category)+'</span>'+(a.audience?'<span class="badge sub">For: '+esc(a.audience)+'</span>':'')+'</div>';
  h+='<h2 class="disp">'+esc(a.title)+'</h2><p class="a-summary">'+esc(a.summary||'')+'</p>';
  if(a.overview){ h+='<div class="sec"><h3>Overview</h3>'+
    '<div class="def"><span class="k">What it does</span><span class="v">'+esc(a.overview.what)+'</span></div>'+
    '<div class="def"><span class="k">Why use it</span><span class="v">'+esc(a.overview.why)+'</span></div>'+
    '<div class="def"><span class="k">Who it\\'s for</span><span class="v">'+esc(a.overview.who)+'</span></div></div>'; }
  if((a.steps||[]).length){ h+='<div class="sec"><h3>Step-by-step</h3><ol class="steps">';
    a.steps.forEach((s,i)=>{ h+='<li class="step"><span class="num">'+(i+1)+'</span><span><span class="st">'+esc(s.title)+'</span><span class="sb">'+esc(s.body)+'</span></span></li>'; });
    h+='</ol></div>'; }
  if(a.expectedResult){ h+='<div class="sec"><h3>Expected result</h3><p class="sb" style="margin:0;color:var(--text-muted);font-size:13.5px;line-height:1.6;">'+esc(a.expectedResult)+'</p></div>'; }
  if((a.commonMistakes||[]).length){ h+='<div class="sec"><h3>Common mistakes</h3><ul class="bul">'+a.commonMistakes.map(m=>'<li>'+esc(m)+'</li>').join('')+'</ul></div>'; }
  if((a.troubleshooting||[]).length){ h+='<div class="sec"><h3>Troubleshooting</h3>'+a.troubleshooting.map(t=>'<div class="tcard"><div class="tp">'+esc(t.problem)+'</div>'+((t.causes||[]).length?'<div class="tl">Possible causes</div><ul class="bul" style="margin-top:4px;">'+t.causes.map(c=>'<li>'+esc(c)+'</li>').join('')+'</ul>':'')+'<div class="fx"><b>Fix: </b>'+esc(t.fix)+'</div></div>').join('')+'</div>'; }
  if((a.faqs||[]).length){ h+='<div class="sec"><h3>FAQ</h3>'+a.faqs.map(f=>'<details class="faq"><summary>'+esc(f.q)+'</summary><p>'+esc(f.a)+'</p></details>').join('')+'</div>'; }
  view.innerHTML=h;
  document.getElementById('aBack').onclick=()=>{ history.pushState({},'',location.pathname); qEl.value=''; renderHome(); };
  window.scrollTo(0,0);
}
function route(){
  const id=new URLSearchParams(location.search).get('a');
  if(id) renderArticle(id); else if(qEl.value.trim()) renderResults(qEl.value); else renderHome();
}
view.addEventListener('click',(e)=>{
  const row=e.target.closest('.row'); if(row){ const id=row.getAttribute('data-id'); history.pushState({},'','?a='+encodeURIComponent(id)); renderArticle(id); return; }
  const cat=e.target.closest('.cat'); if(cat){ renderCat(cat.getAttribute('data-cat')); }
});
qEl.addEventListener('input',()=>{ if(qEl.value.trim()) renderResults(qEl.value); else renderHome(); });
window.addEventListener('popstate',route);
document.getElementById('backBtn').onclick=()=>{ if(history.length>1) history.back(); else location.href='./'; };
route();
</script>
</body>
</html>`;

writeFileSync(`${ROOT}/public-scorecard/help.html`, html);
writeFileSync(`${ROOT}/public-crm/help.html`, html);
console.log(`wrote help.html (${articles.length} articles) to public-scorecard/ and public-crm/`);
