/**
 * rekt — BTC data viewer
 * Express server reading the rekt Postgres DB and serving a single-page
 * dashboard with BTC spot + Polymarket up/down odds over a selectable
 * time range, with a "timefocus" scrubber.
 *
 * Run:  pnpm web   (on Pi5, where the DB lives)
 * Env:  PGUSER/PGDATABASE/PGHOST/PGPORT or DATABASE_URL (same as receiver)
 *       WEB_PORT (default 8080)
 */
import "dotenv/config";
import express from "express";
import { Pool } from "pg";

const PORT = parseInt(process.env.WEB_PORT ?? "8080", 10);

function pgConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    user: process.env.PGUSER ?? "pi",
    database: process.env.PGDATABASE ?? "rekt",
    host: process.env.PGHOST ?? "/var/run/postgresql",
    port: parseInt(process.env.PGPORT ?? "9043", 10),
    max: 3,
  };
}

const pool = new Pool(pgConfig());
const app = express();

// ── helpers ────────────────────────────────────────────────────────
async function q(text: string, params: unknown[]) {
  return pool.query(text, params);
}
const out = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** full data span (ms epoch) — anchors the dual-handle slider */
app.get("/api/span", async (_req, res) => {
  try {
    const r = await q(
      `SELECT COALESCE(min(ts),0) AS first,
              COALESCE(max(ts),0)   AS last,
              (SELECT count(*) FROM spot_ticks) AS spot,
              (SELECT count(*) FROM odds_ticks) AS odds,
              (SELECT count(*) FROM markets)    AS markets
       FROM spot_ticks`,
      [],
    );
    res.json(r.rows[0] ?? { first: 0, last: 0, spot: 0, odds: 0, markets: 0 });
  } catch (e) { res.status(500).json({ error: out(e) }); }
});

/** latest snapshot (live header) */
app.get("/api/overview", async (_req, res) => {
  try {
    const [spot, latest] = await Promise.all([
      q(`SELECT price, ts FROM spot_ticks WHERE asset='btc' ORDER BY ts DESC LIMIT 1`, []),
      q(`SELECT m.slug, m.asset, m.window_end, o.up_mid, o.down_mid,
                o.up_price AS up_gamma, o.down_price AS down_gamma,
                (m.window_end - extract(epoch from now())::int) AS seconds_to_close,
                o.up_ask_depth_95, o.down_ask_depth_95, o.up_best_ask, o.down_best_ask
         FROM odds_ticks o JOIN markets m ON m.id=o.market_id
         WHERE m.window_end > extract(epoch from now())::int   -- actually-live window
         ORDER BY m.window_end ASC, o.ts DESC                 -- soonest-closing, newest tick
         LIMIT 1`, []),
    ]);
    res.json({ spot: spot.rows[0] ?? null, latestMarket: latest.rows[0] ?? null });
  } catch (e) { res.status(500).json({ error: out(e) }); }
});

/**
 * Range-aware series fetch. `from`/`to` are ms epoch; if omitted, last `minutes`.
 * Downsamples so the response stays small (≤ ~600 points/series) regardless of range.
 */
app.get("/api/series", async (req, res) => {
  try {
    const now = Date.now();
    const minutes = Math.min(Math.max(parseInt(String(req.query.minutes ?? "60"), 10) || 60, 1), 1440);
    let from = req.query.from ? parseInt(String(req.query.from), 10) : now - minutes * 60_000;
    let to = req.query.to ? parseInt(String(req.query.to), 10) : now;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      to = now; from = now - minutes * 60_000;
    }
    // bucket size scales with range → bounded point count
    const spanSec = Math.max(1, Math.floor((to - from) / 1000));
    const bucketSec = Math.max(1, Math.round(spanSec / 600));
    const [spot, odds] = await Promise.all([
      q(
        `SELECT (floor(ts/1000/$1)*$1*1000)::bigint AS ts,
                round(avg(price)::numeric, 2) AS price
         FROM spot_ticks WHERE asset='btc' AND ts BETWEEN $2 AND $3
         GROUP BY 1 ORDER BY 1`,
        [bucketSec, from, to],
      ),
      // odds: latest tick per market per bucket keeps the up/down curves clean.
      // Bucket the tick ts itself (no LATERAL — that cartesian-multiplies).
      // Reads up_mid/down_mid (book-derived) — NOT up_price (Gamma, near-frozen).
      q(
        `SELECT DISTINCT ON (m.slug, b) b AS ts, m.slug,
                o.up_mid, o.down_mid,
                o.up_price AS up_gamma, o.down_price AS down_gamma,
                o.seconds_to_close,
                o.up_ask_depth_95, o.down_ask_depth_95
         FROM odds_ticks o
         JOIN markets m ON m.id = o.market_id
         CROSS JOIN LATERAL (SELECT (floor(o.ts/1000/$1)*$1*1000)::bigint AS b) x
         WHERE o.ts BETWEEN $2 AND $3 AND o.ts < m.window_end*1000   -- only ticks while window was actually live
         ORDER BY m.slug, b, o.ts DESC`,
        [bucketSec, from, to],
      ),
    ]);
    res.json({ from, to, bucketSec, spot: spot.rows, odds: odds.rows });
  } catch (e) { res.status(500).json({ error: out(e) }); }
});

app.get("/", (_req, res) => res.type("html").send(PAGE));

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>rekt — BTC live</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/date-fns/locale/en/index.js"></script>
<style>
  :root{ --bg:#0a0e14; --panel:#121822; --panel2:#0d1219; --line:#1f2733; --txt:#e6edf3;
         --mut:#7d8590; --up:#3fb950; --dn:#f85149; --spot:#58a6ff; --amber:#d29922; --accent:#a371f7; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-font-smoothing:antialiased}
  header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;padding:16px 22px;border-bottom:1px solid var(--line)}
  header h1{font-size:16px;margin:0;letter-spacing:.5px} header .sub{color:var(--mut);font-size:12px}
  .live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--up);margin-right:6px;animation:p 1.5s infinite;vertical-align:middle}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
  .wrap{max-width:1280px;margin:0 auto;padding:16px 22px 40px}
  .row{display:grid;gap:16px}
  .row.main{grid-template-columns:1.5fr 1fr}
  .row.focus{grid-template-columns:1fr}
  @media(max-width:980px){.row.main{grid-template-columns:1fr}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .card h2{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--mut);font-weight:600}
  .big{font-size:28px;font-weight:600;line-height:1.1} .delta{font-size:13px;margin-left:8px}
  .up{color:var(--up)} .dn{color:var(--dn)} .mut{color:var(--mut)}
  .mkt{font-size:13px;color:var(--mut);margin-top:10px} .mkt b{color:var(--txt)}
  .chart{height:320px;position:relative;margin-top:4px}
  .chart.sm{height:200px}
  .focusline{position:absolute;top:0;bottom:0;width:1px;background:var(--accent);pointer-events:none;opacity:.7}
  .focusdot{position:absolute;top:0;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--bg);transform:translateX(-50%);z-index:2}
  /* time controls */
  .controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}
  .segs{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .segs button{background:var(--panel2);color:var(--mut);border:0;border-right:1px solid var(--line);
    padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;transition:.12s}
  .segs button:last-child{border-right:0}
  .segs button:hover{color:var(--txt)}
  .segs button.active{background:var(--accent);color:#fff}
  .reset{background:var(--panel2);color:var(--mut);border:1px solid var(--line);border-radius:8px;
    padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;transition:.12s}
  .reset:hover{color:var(--txt);border-color:var(--accent)}
  /* dual-handle slider (custom, pointer-based, works on touch + mouse) */
  .sliderbox{flex:1;min-width:220px}
  .trackwrap{position:relative;height:32px;width:100%;touch-action:none;cursor:pointer;margin-top:6px}
  .trackwrap .track{position:absolute;top:50%;left:0;right:0;height:4px;transform:translateY(-50%);
    background:var(--line);border-radius:2px;pointer-events:none}
  .trackwrap .sel{position:absolute;top:50%;height:4px;transform:translateY(-50%);
    background:var(--accent);opacity:.45;border-radius:2px;pointer-events:none}
  .trackwrap .handle{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;
    background:var(--accent);border:2px solid var(--bg);transform:translate(-50%,-50%);
    cursor:grab;z-index:2;touch-action:none;box-shadow:0 0 0 1px var(--line)}
  .trackwrap .handle:hover{background:var(--txt)}
  .trackwrap .handle:active{cursor:grabbing}
  /* chart drag-zoom selection box */
  .zoomsel{position:absolute;top:0;bottom:0;background:rgba(163,113,247,.16);
    border-left:1px solid var(--accent);border-right:1px solid var(--accent);
    pointer-events:none;display:none;z-index:1}
  .readout{font-size:12px;color:var(--mut);display:flex;gap:18px;flex-wrap:wrap;align-items:baseline}
  .readout b{color:var(--txt);font-weight:600}
  .readout .ts{font-family:inherit}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}
  .stat{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px}
  .stat .n{font-size:18px;font-weight:600} .stat .l{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
  .pair{display:flex;gap:22px;margin-top:6px}
  .pair .l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
  footer{color:var(--mut);font-size:11px;padding:16px 22px;border-top:1px solid var(--line);text-align:center}
  .hint{font-size:11px;color:var(--mut);margin-left:auto}
</style></head><body>
<header>
  <h1>rekt</h1><span class="sub">rektDBfiller · BTC live</span>
  <span class="sub"><span class="live"></span>capturing</span>
  <span class="hint">drag a chart to zoom · drag handles to scrub · dbl-click / ⊗ / Esc to reset</span>
</header>

<div class="wrap">

  <!-- time controls -->
  <div class="card" style="margin-bottom:16px">
    <div class="controls">
      <div class="segs" id="rangeSeg">
        <button data-min="15">15m</button>
        <button data-min="60" class="active">1h</button>
        <button data-min="240">4h</button>
        <button data-min="720">12h</button>
        <button data-min="0">all</button>
      </div>
      <button id="resetBtn" class="reset" title="reset zoom to current preset (Esc)">⊗ reset</button>
      <div class="sliderbox">
        <div class="trackwrap" id="track">
          <div class="track"></div>
          <div class="sel" id="selBand"></div>
          <div class="handle" id="hLo" title="window start"></div>
          <div class="handle" id="hHi" title="window end"></div>
        </div>
      </div>
    </div>
    <div class="readout" id="readout">
      <span>window: <b id="vRange">—</b></span>
      <span>cursor: <b class="ts" id="vFocus">—</b></span>
      <span>BTC @ cursor: <b id="vFocusPrice">—</b></span>
      <span>UP/DOWN @ cursor: <b id="vFocusOdds">—</b></span>
    </div>
  </div>

  <!-- live header -->
  <div class="row main" style="margin-bottom:16px">
    <div class="card"><h2>BTC spot price (USD)</h2>
      <div><span class="big" id="spotPrice">—</span><span class="delta" id="spotDelta"></span></div>
      <div class="chart"><canvas id="spotChart"></canvas>
        <div class="focusline" id="spotLine" style="display:none"></div>
        <div class="focusdot" id="spotDot" style="display:none"></div>
      </div>
    </div>
    <div class="card"><h2>current 5-min market</h2>
      <div class="pair">
        <div><div class="l up">UP</div><span class="big up" id="upPrice">—</span></div>
        <div><div class="l dn">DOWN</div><span class="big dn" id="dnPrice">—</span></div>
      </div>
      <div class="mkt" id="mktInfo">—</div>
      <div class="stats">
        <div class="stat"><div class="n" id="cSpot">0</div><div class="l">spot ticks</div></div>
        <div class="stat"><div class="n" id="cOdds">0</div><div class="l">odds ticks</div></div>
        <div class="stat"><div class="n" id="cMkt">0</div><div class="l">markets</div></div>
        <div class="stat"><div class="n" id="cHr">—</div><div class="l">capture hrs</div></div>
      </div>
    </div>
  </div>

  <!-- odds over the selected range -->
  <div class="row focus">
    <div class="card"><h2>UP / DOWN odds — <span class="mut" id="oddsRange">—</span></h2>
      <div class="chart sm"><canvas id="oddsChart"></canvas>
        <div class="focusline" id="oddsLine" style="display:none"></div>
      </div>
    </div>
  </div>
</div>

<footer>rekt · reads Postgres <code>rekt</code> db · live refresh 20s (overview) / 60s (series) · all times local</footer>

<script>
const $=id=>document.getElementById(id);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;          // e.g. "Europe/Vienna"
const TZ_SHORT = new Date().toLocaleTimeString([], {timeZoneName:'short'}).match(/\\b[A-Z]{3,4}\\b/g)?.pop() || TZ; // e.g. "CEST"
const fmtTime=ms=>new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const fmtHM =ms=>new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const fmtDT =ms=>new Date(ms).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const fmt$  =n=>'$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:0});

// ── state ──────────────────────────────────────────────────────────
let SPAN={first:0,last:0,spot:0,odds:0,markets:0};   // full capture range
// Zoom model.  MODE='latest'  → window follows SPAN.last via lastPreset (rolls on refresh).
//              MODE='manual' → window frozen at [winFrom,winTo] (user zoomed).
let MODE='latest';
let lastPreset=60;        // duration (min) to return to on reset; 0 = all
let winFrom=0, winTo=0;   // absolute ms; source of truth when MODE==='manual'
let hover={time:null,price:null,odds:null};
let lastSeries=null;
let dragging=false;       // suppress hover readouts during chart drag-zoom

// ── charts ─────────────────────────────────────────────────────────
const xTime={type:'time',display:true,time:{displayFormats:{minute:'HH:mm',hour:'HH:mm',day:'MMM d'}},
  title:{display:true,text:'Time ('+TZ_SHORT+')',color:'#7d8590',font:{size:10}},
  grid:{color:'#1f2733'},ticks:{color:'#7d8590',maxRotation:0,autoSkip:true,maxTicksLimit:8}};
const yAxis=lbl=>({grid:{color:'#1f2733'},ticks:{color:'#7d8590'},
  title:{display:!!lbl,text:lbl,color:'#7d8590',font:{size:10}}});
function mkChart(ctx,datasets,yopts){return new Chart(ctx,{type:'line',data:{datasets},
  options:{animation:false,responsive:true,maintainAspectRatio:false,interaction:{mode:'nearest',axis:'x',intersect:false},
    plugins:{legend:{display:false},tooltip:{callbacks:{
      title:its=>fmtDT(its[0].parsed.x),
      label:it=>it.dataset.label+': '+it.parsed.y.toFixed(2)}}},
    scales:{x:xTime,y:yopts}}});}
const spotC=mkChart('spotChart',[{label:'BTC',data:[],borderColor:'var(--spot)',backgroundColor:'rgba(88,166,255,.12)',fill:true,borderWidth:2,pointRadius:0,tension:.25}],yAxis('USD'));
const oddsC=mkChart('oddsChart',[
  {label:'UP',data:[],borderColor:'var(--up)',backgroundColor:'rgba(63,185,80,.10)',fill:true,borderWidth:2,pointRadius:0,tension:.2},
  {label:'DOWN',data:[],borderColor:'var(--dn)',backgroundColor:'rgba(248,81,73,.08)',fill:true,borderWidth:2,pointRadius:0,tension:.2}],
  {min:0,max:100,grid:{color:'#1f2733'},ticks:{color:'#7d8590',callback:v=>v+'%'},title:{display:true,text:'implied probability (%)',color:'#7d8590',font:{size:10}}});

// ── time math ──────────────────────────────────────────────────────
function rangeBounds(){
  if(!SPAN.last) return {from:Date.now()-3600e3,to:Date.now()};
  if(MODE==='manual') return {from:Math.min(winFrom,winTo),to:Math.max(winFrom,winTo)};
  if(lastPreset===0) return {from:SPAN.first,to:SPAN.last};
  const to=SPAN.last, from=to-lastPreset*60e3;
  return {from:Math.max(from,SPAN.first),to};
}
function pctOf(ms){ if(!isFinite(+SPAN.first)||!isFinite(+SPAN.last)||SPAN.last<=SPAN.first) return 0; return Math.max(0,Math.min(1,(ms-SPAN.first)/(SPAN.last-SPAN.first))); }
function msOf(p){ return Math.round(SPAN.first + p*(SPAN.last-SPAN.first)); }
function durStr(ms){
  const s=Math.max(0,Math.round(ms/1000)); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  if(h>0) return h+'h'+(m>0?' '+m+'m':'');
  if(m>0) return m+'m'+(sec>0?' '+sec+'s':'');
  return sec+'s';
}

// ── slider + readouts ──────────────────────────────────────────────
function renderSlider(){
  // No data yet (or error response) → show the full track selected; slider is inert.
  const noSpan = !isFinite(+SPAN.last)||SPAN.last<=SPAN.first;
  let lo, hi;
  if(noSpan){ lo=0; hi=1; }
  else { const {from,to}=rangeBounds(); lo=pctOf(from); hi=pctOf(to); }
  $('hLo').style.left=(lo*100)+'%'; $('hHi').style.left=(hi*100)+'%';
  $('selBand').style.left=(lo*100)+'%'; $('selBand').style.width=((hi-lo)*100)+'%';
}
function renderRange(){
  const {from,to}=rangeBounds(); const span=to-from;
  const f = span>24*3600e3 ? fmtDT : fmtHM;
  $('vRange').textContent=f(from)+' \\u2192 '+f(to)+' ('+TZ_SHORT+') \\u00b7 '+durStr(span)+(MODE==='manual'?'  [manual]':'');
  $('oddsRange').textContent=f(from)+' \\u2192 '+f(to)+' ('+TZ_SHORT+')';
  renderHover();
}
function renderHover(){
  const {from,to}=rangeBounds();
  const t = hover.time!=null?hover.time:(from+to)/2;
  $('vFocus').textContent=fmtDT(t)+' '+TZ_SHORT;
  const p=$('vFocusPrice'); p.textContent=hover.price!=null?fmt$(hover.price):'\\u2014'; p.className=hover.price!=null?'b':'b mut';
  $('vFocusOdds').textContent=hover.odds!=null?hover.odds:'\\u2014';
}

// ── dual-handle slider wiring (pointer events: mouse + touch) ──────
const trackEl=$('track');
let dragH=null;   // 'lo' | 'hi' | null
function pctFromX(x){ const r=trackEl.getBoundingClientRect(); return Math.max(0,Math.min(1,(x-r.left)/r.width)); }
function moveHandle(which,p){
  const cur=rangeBounds();
  let lo=pctOf(cur.from), hi=pctOf(cur.to);
  if(which==='lo') lo=Math.min(p, hi-0.003); else hi=Math.max(p, lo+0.003);
  MODE='manual'; clearPresetActive();
  winFrom=msOf(lo); winTo=msOf(hi);
  renderSlider(); renderRange();   // readouts update live; data refetched on pointerup
}
trackEl.addEventListener('pointerdown',e=>{
  if(e.target.id==='hHi') dragH='hi';
  else if(e.target.id==='hLo') dragH='lo';
  else { // clicked the track: jump the nearer handle
    const p=pctFromX(e.clientX); const cur=rangeBounds();
    const lo=pctOf(cur.from), hi=pctOf(cur.to);
    dragH = Math.abs(p-lo)<=Math.abs(p-hi)?'lo':'hi';
    moveHandle(dragH,p);
  }
  e.preventDefault();
  try{ trackEl.setPointerCapture(e.pointerId); }catch(_){}
  dragging=true;
});
trackEl.addEventListener('pointermove',e=>{ if(!dragH)return; moveHandle(dragH,pctFromX(e.clientX)); });
function endSliderDrag(e){ if(!dragH)return; dragH=null; dragging=false; try{ trackEl.releasePointerCapture(e.pointerId); }catch(_){} loadSeries(); }
trackEl.addEventListener('pointerup',endSliderDrag);
trackEl.addEventListener('pointercancel',endSliderDrag);

// ── presets + reset ────────────────────────────────────────────────
function clearPresetActive(){ $('rangeSeg').querySelectorAll('button').forEach(b=>b.classList.remove('active')); }
function applyPreset(min){
  MODE='latest'; lastPreset=min;
  clearPresetActive();
  const btn=[].slice.call($('rangeSeg').querySelectorAll('button')).find(b=>+b.dataset.min===min);
  if(btn) btn.classList.add('active');
  renderSlider(); renderRange(); loadSeries();
}
$('rangeSeg').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b)return; applyPreset(+b.dataset.min); });
$('resetBtn').addEventListener('click',()=>applyPreset(lastPreset));
window.addEventListener('keydown',e=>{ if(e.key==='Escape' && MODE==='manual') applyPreset(lastPreset); });

// ── chart hover (cursor readouts + focus line) ─────────────────────
function nearestIdx(chart,e){ const els=chart.getElementsAtEventForMode(e,'index',{intersect:false},false); return els.length?els[0].index:null; }
function attachHover(chart,canvasId,lineId,kind){
  const cv=$(canvasId); const wrap=cv.parentElement; const line=$(lineId);
  const moveSpotDot = kind==='spot';
  cv.addEventListener('mousemove',e=>{
    if(dragging) return;
    const r=wrap.getBoundingClientRect(); const px=(e.clientX-r.left)/r.width*100;
    line.style.display='block'; line.style.left=px+'%';
    if(moveSpotDot){ $('spotDot').style.display='block'; $('spotDot').style.left=px+'%'; }
    const idx=nearestIdx(chart,e);
    if(idx!=null){
      const pt0=chart.data.datasets[0].data[idx];
      if(pt0){ hover.time=pt0.x;
        if(kind==='spot'){ hover.price=pt0.y; }
        else { const u=chart.data.datasets[0].data[idx], d=chart.data.datasets[1].data[idx];
          hover.odds=(u&&d)?(u.y.toFixed(0)+'% / '+d.y.toFixed(0)+'%'):'\\u2014'; }
      }
    }
    renderHover();
  });
  cv.addEventListener('mouseleave',()=>{
    line.style.display='none'; if(moveSpotDot) $('spotDot').style.display='none';
    if(kind==='spot') hover.price=null; else hover.odds=null; renderHover();
  });
}

// ── chart click-drag zoom ──────────────────────────────────────────
function attachZoom(chart,canvasId){
  const cv=$(canvasId); const wrap=cv.parentElement;
  let box=wrap.querySelector('.zoomsel');
  if(!box){ box=document.createElement('div'); box.className='zoomsel'; wrap.appendChild(box); }
  let downX=null, moved=false;
  // map a canvas-relative px → ms using the rendered scale bounds (robust across Chart.js builds)
  function timeAt(px){
    const ca=chart.chartArea, s=chart.scales.x;
    if(!ca || !s || s.min==null || s.max==null || s.max<=s.min) return null;
    return s.min + (px-ca.left)/(ca.right-ca.left)*(s.max-s.min);
  }
  cv.addEventListener('pointerdown',e=>{ if(e.button!==0) return; downX=e.clientX; moved=false;
    try{ cv.setPointerCapture(e.pointerId); }catch(_){} });
  cv.addEventListener('pointermove',e=>{
    if(downX==null) return;
    if(Math.abs(e.clientX-downX)>4){ moved=true; dragging=true; }
    if(moved){ const r=wrap.getBoundingClientRect();
      const x0=Math.min(downX,e.clientX)-r.left, x1=Math.max(downX,e.clientX)-r.left;
      box.style.display='block'; box.style.left=x0+'px'; box.style.width=(x1-x0)+'px'; }
  });
  function up(e){
    try{ cv.releasePointerCapture(e.pointerId); }catch(_){}
    box.style.display='none';
    if(!moved){ downX=null; dragging=false; return; }   // plain click → leave tooltip alone
    const cr=cv.getBoundingClientRect();
    const px0=Math.min(downX,e.clientX)-cr.left, px1=Math.max(downX,e.clientX)-cr.left;
    downX=null; dragging=false;
    let t0=timeAt(px0), t1=timeAt(px1);
    if(t0==null||t1==null||t1-t0<2000) return;          // ignore trivial selections
    if(t1<t0){ const tmp=t0; t0=t1; t1=tmp; }
    setManualWindow(t0,t1);
  }
  cv.addEventListener('pointerup',up);
  cv.addEventListener('pointercancel',()=>{ box.style.display='none'; downX=null; moved=false; dragging=false; });
  cv.addEventListener('dblclick',()=>applyPreset(lastPreset));
}
function setManualWindow(from,to){
  MODE='manual'; winFrom=from; winTo=to; clearPresetActive();
  renderSlider(); renderRange(); loadSeries();
}

// ── data fetch ─────────────────────────────────────────────────────
async function loadSpan(){
  try{
    const r=await fetch('api/span'); const d=await r.json();
    // coerce + guard: an error response (no DB) or empty rows yields all-zero fields
    SPAN={first:+d.first||0,last:+d.last||0,spot:+d.spot||0,odds:+d.odds||0,markets:+d.markets||0};
  }catch(e){console.error(e);}
}
async function loadSeries(){
  const {from,to}=rangeBounds();
  try{
    const r=await fetch('api/series?from='+from+'&to='+to); const d=await r.json(); lastSeries=d;
    // spot → {x: Date ms, y: price} for the time scale
    spotC.data.datasets[0].data=d.spot.map(p=>({x:+p.ts, y:+p.price}));
    spotC.update('none');
    // odds — show the market with the most points (clean single curve over the range)
    if(d.odds.length){
      const byM={}; d.odds.forEach(r=>{(byM[r.slug]=byM[r.slug]||[]).push(r);});
      const busiest=Object.entries(byM).sort((a,b)=>b[1].length-a[1].length)[0][1].sort((a,b)=>a.ts-b.ts);
      oddsC.data.datasets[0].data=busiest.map(r=>({x:+r.ts, y:(r.up_mid!=null?r.up_mid:r.up_gamma)*100}));
      oddsC.data.datasets[1].data=busiest.map(r=>({x:+r.ts, y:(r.down_mid!=null?r.down_mid:r.down_gamma)*100}));
    } else { oddsC.data.datasets.forEach(ds=>ds.data=[]); }
    oddsC.update('none');
  }catch(e){console.error(e);}
}
async function loadOverview(){
  try{
    const r=await fetch('api/overview'); const o=await r.json();
    if(o.spot){latestSpotPrice=+o.spot.price; $('spotPrice').textContent=fmt$(latestSpotPrice);}
    if(o.latestMarket){const m=o.latestMarket;
      $('upPrice').textContent=m.up_mid!=null?(m.up_mid*100).toFixed(1)+'%':(m.up_gamma!=null?'~'+(m.up_gamma*100).toFixed(0)+'%*':'\\u2014');
      $('dnPrice').textContent=m.down_mid!=null?(m.down_mid*100).toFixed(1)+'%':(m.down_gamma!=null?'~'+(m.down_gamma*100).toFixed(0)+'%*':'\\u2014');
      $('mktInfo').innerHTML='window ends <b>'+(m.seconds_to_close>0?fmtTime(Date.now()+m.seconds_to_close*1000):'\\u2014')+'</b>';
    }
    $('cSpot').textContent=Number(SPAN.spot).toLocaleString();
    $('cOdds').textContent=Number(SPAN.odds).toLocaleString();
    $('cMkt').textContent=Number(SPAN.markets).toLocaleString();
    $('cHr').textContent=SPAN.first?((SPAN.last-SPAN.first)/3600e3).toFixed(1):'\\u2014';
    if(latestSpotPrice!=null && lastSeries && lastSeries.spot.length){
      const first=lastSeries.spot[0].price; const dd=(latestSpotPrice-first)/first*100;
      const el=$('spotDelta'); el.textContent=(dd>=0?'+':'')+dd.toFixed(2)+'%'; el.className='delta '+(dd>=0?'up':'dn');
    }
  }catch(e){console.error(e);}
}
let latestSpotPrice=null;

// ── wire hover/zoom ────────────────────────────────────────────────
attachHover(spotC,'spotChart','spotLine','spot');
attachHover(oddsC,'oddsChart','oddsLine','odds');
attachZoom(spotC,'spotChart');
attachZoom(oddsC,'oddsChart');

async function refreshAll(){
  await loadSpan();
  if(!winTo){ const b=rangeBounds(); winFrom=b.from; winTo=b.to; }   // init manual defaults
  await Promise.all([loadSeries(),loadOverview()]);
  renderSlider(); renderRange();
}
refreshAll();
setInterval(loadOverview,20000);          // live header refreshes fast
// series slower; rangeBounds() respects MODE → presets roll, manual stays frozen (no snap)
setInterval(async()=>{ await loadSpan(); await loadSeries(); renderSlider(); renderRange(); },60000);
</script></body></html>`;

app.listen(PORT, () => { console.log(`rekt web → http://localhost:${PORT}`); });
