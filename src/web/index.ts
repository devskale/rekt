/**
 * rekt — BTC data viewer (proto)
 * Tiny Express server reading the rekt Postgres DB and serving a
 * single-page dashboard with BTC spot price + Polymarket up/down odds.
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

// ── API: latest snapshot + recent series ───────────────────────────
app.get("/api/overview", async (_req, res) => {
  try {
    const [spot, counts, latestMarket, oddsSpan] = await Promise.all([
      pool.query(
        `SELECT price, to_timestamp(ts/1000.0) AT TIME ZONE 'UTC' AS t
         FROM spot_ticks WHERE asset='btc' ORDER BY ts DESC LIMIT 1`,
      ),
      pool.query(
        `SELECT
           (SELECT count(*) FROM spot_ticks) AS spot,
           (SELECT count(*) FROM odds_ticks) AS odds,
           (SELECT count(*) FROM markets)    AS markets`,
      ),
      pool.query(
        `SELECT slug, asset, up_price, down_price, seconds_to_close,
                to_timestamp(window_end) AT TIME ZONE 'UTC' AS window_end_t
         FROM odds_ticks o JOIN markets m ON m.id=o.market_id
         ORDER BY o.ts DESC LIMIT 1`,
      ),
      pool.query(
        `SELECT to_timestamp(min(ts)/1000.0) AT TIME ZONE 'UTC' AS first,
                to_timestamp(max(ts)/1000.0) AT TIME ZONE 'UTC' AS last
         FROM odds_ticks`,
      ),
    ]);
    res.json({
      spot: spot?.rows[0] ?? null,
      counts: counts?.rows[0] ?? { spot: 0, odds: 0, markets: 0 },
      latestMarket: latestMarket?.rows[0] ?? null,
      span: oddsSpan?.rows[0] ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── API: BTC spot price series (downsampled) ───────────────────────
app.get("/api/spot", async (req, res) => {
  const minutes = Math.min(parseInt(String(req.query.minutes ?? "480"), 10), 1440);
  try {
    const r = await pool.query(
      `SELECT (ts/1000)::bigint AS ts, price
       FROM spot_ticks
       WHERE asset='btc' AND ts > (extract(epoch from now()-($1||' minutes')::interval)*1000)::bigint
       ORDER BY ts`,
      [minutes],
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── API: up/down odds series for the busiest recent markets ────────
app.get("/api/odds", async (req, res) => {
  const minutes = Math.min(parseInt(String(req.query.minutes ?? "480"), 10), 1440);
  try {
    const r = await pool.query(
      `SELECT (o.ts/1000)::bigint AS ts,
              o.seconds_to_close,
              o.up_price,
              o.down_price,
              o.up_ask_depth_95,
              m.slug
       FROM odds_ticks o JOIN markets m ON m.id = o.market_id
       WHERE o.ts > (extract(epoch from now()-($1||' minutes')::interval)*1000)::bigint
       ORDER BY o.ts`,
      [minutes],
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/", (_req, res) => res.type("html").send(PAGE));

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>rekt — BTC live</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root{ --bg:#0a0e14; --panel:#121822; --line:#1f2733; --txt:#e6edf3; --mut:#7d8590;
         --up:#3fb950; --dn:#f85149; --spot:#58a6ff; --amber:#d29922; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-font-smoothing:antialiased}
  header{display:flex;align-items:baseline;gap:14px;padding:18px 22px;border-bottom:1px solid var(--line)}
  header h1{font-size:16px;margin:0;letter-spacing:.5px} header .sub{color:var(--mut);font-size:12px}
  .grid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;padding:16px 22px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .card h2{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--mut)}
  .big{font-size:30px;font-weight:600}
  .delta{font-size:14px;margin-left:8px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
  .stat{background:#0d1219;border:1px solid var(--line);border-radius:8px;padding:10px}
  .stat .n{font-size:20px;font-weight:600} .stat .l{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px}
  .chart{height:300px;position:relative}
  .mkt{font-size:13px;color:var(--mut);margin-top:8px}
  .mkt b{color:var(--txt)}
  .up{color:var(--up)} .dn{color:var(--dn)}
  footer{color:var(--mut);font-size:11px;padding:14px 22px;border-top:1px solid var(--line)}
  .live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--up);margin-right:6px;animation:p 1.5s infinite}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
</style></head><body>
<header><h1>rekt</h1><span class="sub">rektDBfiller · BTC live data</span>
  <span class="sub" id="live"><span class="live"></span>capturing</span></header>
<div class="grid">
  <div class="card"><h2>BTC spot (USD)</h2>
    <div><span class="big" id="spotPrice">—</span><span class="delta" id="spotDelta"></span></div>
    <div class="chart"><canvas id="spotChart"></canvas></div></div>
  <div class="card"><h2>current 5-min market</h2>
    <div style="display:flex;gap:18px;margin-top:6px">
      <div><div class="l up" style="font-size:10px">UP</div><span class="big up" id="upPrice">—</span></div>
      <div><div class="l dn" style="font-size:10px">DOWN</div><span class="big dn" id="dnPrice">—</span></div></div>
    <div class="mkt" id="mktInfo">—</div>
    <div class="stats"><div class="stat"><div class="n" id="cSpot">0</div><div class="l">spot ticks</div></div>
      <div class="stat"><div class="n" id="cOdds">0</div><div class="l">odds ticks</div></div>
      <div class="stat"><div class="n" id="cMkt">0</div><div class="l">markets</div></div></div>
    <div class="chart" style="height:170px;margin-top:8px"><canvas id="oddsChart"></canvas></div></div>
</div>
<footer>reads <code>rekt</code> Postgres · refresh 15s · proto viewer</footer>
<script>
const $=id=>document.getElementById(id);
const mk=(ctx,lab,col,fill)=>new Chart(ctx,{type:'line',data:{labels:[],datasets:[
  {label:lab,data:[],borderColor:col,backgroundColor:fill,fill:!!fill,
   borderWidth:2,pointRadius:0,tension:.25}]},
  options:{animation:false,responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false}},
    scales:{x:{display:false},y:{grid:{color:'#1f2733'},ticks:{color:'#7d8590',maxTicksLimit:6}}}}});
const spotC=mk('spotChart','BTC','var(--spot)','rgba(88,166,255,.12)');
const oddsC=mk('oddsChart','UP','var(--up)','rgba(63,185,80,.12)');
// second dataset for down on odds chart
oddsC.data.datasets.push({label:'DOWN',data:[],borderColor:'#f85149',backgroundColor:'rgba(248,81,73,.10)',fill:true,borderWidth:2,pointRadius:0,tension:.25});
let firstSpot=null;
async function go(){
 try{
  const [o,s,d]=await Promise.all(['/api/overview','/api/spot?minutes=480','/api/odds?minutes=120'].map(u=>fetch(u).then(r=>r.json())));
  if(o.spot){$('spotPrice').textContent='$'+Number(o.spot.price).toLocaleString(undefined,{maximumFractionDigits:0});}
  $('cSpot').textContent=Number(o.counts.spot).toLocaleString();
  $('cOdds').textContent=Number(o.counts.odds).toLocaleString();
  $('cMkt').textContent=Number(o.counts.markets).toLocaleString();
  if(o.latestMarket){const m=o.latestMarket;
    $('upPrice').textContent=(m.up_price!=null?(m.up_price*100).toFixed(1)+'%':'—');
    $('dnPrice').textContent=(m.down_price!=null?(m.down_price*100).toFixed(1)+'%':'—');
    const sec=m.seconds_to_close; const mm=String(m.slug).match(/5m-(\\d+)$/);
    $('mktInfo').innerHTML='window ends <b>'+new Date(sec>0?Date.now()+sec*1000:0).toLocaleTimeString()+'</b>';
  }
  // spot chart
  spotC.data.labels=s.map(r=>r.ts); spotC.data.datasets[0].data=s.map(r=>r.price);
  if(s.length){firstSpot=firstSpot??s[0].price; const last=s[s.length-1].price;
    const d2=((last-firstSpot)/firstSpot*100); const el=$('spotDelta');
    el.textContent=(d2>=0?'+':'')+d2.toFixed(2)+'%'; el.className='delta '+(d2>=0?'up':'dn');}
  spotC.update('none');
  // odds chart (group by slug → show the active market's series)
  if(d.length){const byM={};d.forEach(r=>{(byM[r.slug]=byM[r.slug]||[]).push(r)});
    const keys=Object.keys(byM); const active=keys.sort((a,b)=>byM[b].length-byM[a].length)[0];
    const rows=byM[active];
    oddsC.data.labels=rows.map(r=>r.ts);
    oddsC.data.datasets[0].data=rows.map(r=>r.up_price*100);
    oddsC.data.datasets[1].data=rows.map(r=>r.down_price*100);
    oddsC.options.scales.y.max=100;oddsC.options.scales.y.min=0;
    oddsC.update('none');}
 }catch(e){console.error(e);}
}
go(); setInterval(go,15000);
</script></body></html>`;

app.listen(PORT, () => {
  console.log(`rekt web → http://localhost:${PORT}`);
});
