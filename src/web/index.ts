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

/** full data span (ms epoch) — anchors the timefocus slider */
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
  .sliderbox{flex:1;min-width:220px}
  .slider{position:relative;height:28px;display:flex;align-items:center}
  input[type=range]{-webkit-appearance:none;width:100%;background:transparent;margin:0}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;height:18px;width:18px;border-radius:50%;
    background:var(--accent);border:2px solid var(--bg);cursor:grab;margin-top:-7px}
  input[type=range]::-moz-range-thumb{height:16px;width:16px;border-radius:50%;background:var(--accent);border:2px solid var(--bg);cursor:grab}
  input[type=range]::-webkit-slider-runnable-track{height:4px;background:var(--line);border-radius:2px}
  input[type=range]::-moz-range-track{height:4px;background:var(--line);border-radius:2px}
  .rangebar{position:relative;height:4px;background:var(--line);border-radius:2px;margin:12px 0 4px}
  .rangefill{position:absolute;top:0;bottom:0;background:var(--accent);opacity:.35;border-radius:2px}
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
  <span class="hint">drag slider to scrub · click range to zoom</span>
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
      <div class="sliderbox">
        <div class="rangebar"><div class="rangefill" id="rangeFill"></div></div>
        <div class="slider">
          <input type="range" id="focus" min="0" max="1000" value="1000" step="1">
        </div>
      </div>
    </div>
    <div class="readout" id="readout">
      <span>zoom window: <b id="vRange">—</b></span>
      <span>focus time: <b class="ts" id="vFocus">—</b></span>
      <span>BTC @ focus: <b id="vFocusPrice">—</b></span>
      <span>UP/DOWN @ focus: <b id="vFocusOdds">—</b></span>
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

<footer>rekt · reads Postgres <code>rekt</code> db · live refresh 20s · all times local</footer>

<script>
const $=id=>document.getElementById(id);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;          // e.g. "Europe/Vienna"
const TZ_SHORT = new Date().toLocaleTimeString([], {timeZoneName:'short'}).match(/\b[A-Z]{3,4}\b/g)?.pop() || TZ; // e.g. "CEST"
const fmtTime=ms=>new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const fmtHM =ms=>new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const fmtDT =ms=>new Date(ms).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const fmt$  =n=>'$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:0});

// ── state ──────────────────────────────────────────────────────────
let SPAN={first:0,last:0,spot:0,odds:0,markets:0};   // full capture range
let rangeMin=60;                                       // current zoom window (0=all)
let focusPct=1000;                                     // slider 0..1000 (rightmost)
let latestSpotPrice=null, lastSeries=null;

// ── charts ─────────────────────────────────────────────────────────
// Charts use Chart.js time scale (x) so ticks render as real clock times
// (09:05, 09:10…) auto-fit to the visible span. All times are LOCAL + shown TZ.
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
  if(rangeMin===0) return {from:SPAN.first,to:SPAN.last};
  const to=SPAN.last, from=to-rangeMin*60e3;
  return {from:Math.max(from,SPAN.first),to};
}
function focusMs(){
  const {from,to}=rangeBounds();
  return from + (to-from)*(focusPct/1000);
}
function fmtRange(min){
  if(min===0) return 'all';
  if(min<60) return min+'m';
  if(min%60===0) return (min/60)+'h';
  return (min/60).toFixed(1)+'h';
}

// ── render slider bar + readouts ───────────────────────────────────
function renderRange(){
  const {from,to}=rangeBounds();
  const span=Math.max(0,to-from);
  $('vRange').textContent=rangeMin===0?('all ('+(span/3600e3).toFixed(1)+'h)'):fmtRange(rangeMin);
  $('oddsRange').textContent=fmtHM(from)+' → '+fmtHM(to)+' ('+TZ_SHORT+')';
  $('rangeFill').style.width=(rangeMin===0?100:(rangeMin*60e3/span*100))+'%';
  $('vFocus').textContent=fmtDT(focusMs())+' '+TZ_SHORT;
  // focus line position on spot chart (x of focus relative to from..to)
  const fp=(focusMs()-from)/(span||1);
  ['spotLine'].forEach(id=>{const el=$(id);el.style.display=fp>=0&&fp<=1?'block':'none';el.style.left=(fp*100)+'%';});
  $('oddsLine').style.left=(fp*100)+'%';$('oddsLine').style.display=fp>=0&&fp<=1?'block':'none';
  $('spotDot').style.left=(fp*100)+'%';$('spotDot').style.display=fp>=0&&fp<=1?'block':'none';
  // focus values: interpolate from series at focusMs
  const f=$('vFocusPrice'), o=$('vFocusOdds');
  if(lastSeries && lastSeries.spot.length){
    const s=lastSeries.spot; const t=focusMs()/1000;
    let i=s.findIndex(p=>p.ts/1000>=t); if(i<0)i=s.length-1; const p=s[i]||s[s.length-1];
    if(p){f.textContent=fmt$(p.price); const d=p.price-lastSeries.spot[0].price; f.className='b '+(d>=0?'up':'dn');}
  } else f.textContent='—';
  if(lastSeries && lastSeries.odds.length){
    const t=focusMs()/1000; const near=[...lastSeries.odds].sort((a,b)=>Math.abs(a.ts/1000-t)-Math.abs(b.ts/1000-t))[0];
    o.textContent=near?(near.up_mid!=null?(near.up_mid*100).toFixed(0)+'% / '+(near.down_mid*100).toFixed(0)+'%':(near.up_gamma!=null?'~'+(near.up_gamma*100).toFixed(0)+'% (gamma)':'—')):'—';
  } else o.textContent='—';
}

// ── data fetch ─────────────────────────────────────────────────────
async function loadSpan(){
  try{ const r=await fetch('api/span'); const d=await r.json(); SPAN=d; }catch(e){console.error(e);}
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
      $('upPrice').textContent=m.up_mid!=null?(m.up_mid*100).toFixed(1)+'%':(m.up_gamma!=null?'~'+(m.up_gamma*100).toFixed(0)+'%*':'—');
      $('dnPrice').textContent=m.down_mid!=null?(m.down_mid*100).toFixed(1)+'%':(m.down_gamma!=null?'~'+(m.down_gamma*100).toFixed(0)+'%*':'—');
      $('mktInfo').innerHTML='window ends <b>'+(m.seconds_to_close>0?fmtTime(Date.now()+m.seconds_to_close*1000):'—')+'</b>';
    }
    $('cSpot').textContent=Number(SPAN.spot).toLocaleString();
    $('cOdds').textContent=Number(SPAN.odds).toLocaleString();
    $('cMkt').textContent=Number(SPAN.markets).toLocaleString();
    $('cHr').textContent=SPAN.first?((SPAN.last-SPAN.first)/3600e3).toFixed(1):'—';
    if(latestSpotPrice!=null && lastSeries && lastSeries.spot.length){
      const first=lastSeries.spot[0].price; const dd=(latestSpotPrice-first)/first*100;
      const el=$('spotDelta'); el.textContent=(dd>=0?'+':'')+dd.toFixed(2)+'%'; el.className='delta '+(dd>=0?'up':'dn');
    }
  }catch(e){console.error(e);}
}

async function refreshAll(){ await loadSpan(); await Promise.all([loadSeries(),loadOverview()]); renderRange(); }

// ── wire controls ──────────────────────────────────────────────────
$('rangeSeg').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b)return;
  $('rangeSeg').querySelectorAll('button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); rangeMin=+b.dataset.min;
  // snap focus to right edge on range change (show latest by default)
  focusPct=1000; $('focus').value=1000;
  refreshAll();
});
$('focus').addEventListener('input',e=>{ focusPct=+e.target.value; renderRange(); });

// initial + periodic
refreshAll();
setInterval(loadOverview,20000);          // live header refreshes fast
setInterval(()=>{ loadSpan(); loadSeries(); renderRange(); }, 60000); // series slower
</script></body></html>`;

app.listen(PORT, () => { console.log(`rekt web → http://localhost:${PORT}`); });
