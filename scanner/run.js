'use strict';
/* Crash Buyer paper trader (rule: coin 24h <= -20% AND BTC 24h <= -5%, hold 24h).
   Runs on GitHub Actions. Binance public data only. No API keys. Paper trading only. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DATA = path.join(__dirname, '..', 'docs', 'data'), CFGP = path.join(__dirname, '..', 'config.json'), H = 3600e3;
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const D = { startEquity: 1000, frac: 0.05, maxExp: 0.5, maxPos: 20, fee: 0.001, slipBase: 0.002, slipHarsh: 0.01, slipLive: 0.005,
  coinDrop: 0.2, btcDrop: 0.05, minVol: 5e6, lookbackH: 4, liveMaxLagMin: 60, hold: 24 };
const TESTED = new Set('BTC ETH BNB SOL XRP ADA DOGE AVAX DOT LINK MATIC LTC ATOM NEAR UNI ETC XLM ALGO FIL AAVE SAND MANA AXS GALA CHZ ENJ THETA EOS XTZ FTM RUNE CRV SNX COMP 1INCH LRC ZIL ONE HBAR VET TRX ICP APE OP ARB INJ LDO DYDX WAVES QNT MOVR LSK LUNA FTT ANC BNX XMR'.split(' '));
const STABLE = new Set(['USDC', 'TUSD', 'BUSD', 'USDP', 'USDS', 'FDUSD', 'DAI', 'AEUR', 'EUR', 'EURI', 'UST', 'PAXG', 'XAUT', 'USD1', 'PYUSD', 'RLUSD', 'WBTC', 'GBP', 'TRY', 'BRL', 'AUD', 'JPY']);
const sleep = ms => new Promise(r => setTimeout(r, ms)), log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function jget(p) {
  let err;
  for (const h of HOSTS) for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(h + p);
      if (r.status === 429 || r.status === 418) { await sleep(2500 * (t + 1)); continue; }
      if (r.status === 451 || r.status === 403) break;
      if (!r.ok) { err = new Error('HTTP ' + r.status); break; }
      return await r.json();
    } catch (e) { err = e; await sleep(600); }
  }
  throw err || new Error('fetch failed');
}
async function pool(items, limit, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
const kl = (s, n) => jget(`/api/v3/klines?symbol=${s}&interval=1h&limit=${n}`);
async function openAt(s, ms) {
  try { const r = await jget(`/api/v3/klines?symbol=${s}&interval=1h&startTime=${ms}&limit=1`); return r && r[0] && r[0][0] === ms ? +r[0][1] : null; } catch (e) { return null; }
}

/* one paper account: sizes each trade as frac of equity, caps total exposure, replays in time order */
function sim(cfg, sigs, key, now, live) {
  const T = [];
  for (const s of sigs) {
    const x = s.entryMs + cfg.hold * H; let t;
    if (key === 'base') t = { e: s.entryMs, x, pe: s.px.be, pv: s.px.bx, slip: cfg.slipBase };
    else if (key === 'harsh') t = { e: s.entryMs + H, x: s.entryMs + H + cfg.hold * H, pe: s.px.he, pv: s.px.hx, slip: cfg.slipHarsh };
    else t = { e: s.firstSeen, x, pe: s.fsPrice, pv: s.px.lx, slip: cfg.slipLive };
    Object.assign(t, { s, sym: s.sym, st: 'PENDING' });
    if (key === 'live' && s.firstSeen - s.entryMs > cfg.liveMaxLagMin * 60e3) { t.st = `SKIPPED: seen ${Math.round((s.firstSeen - s.entryMs) / 60e3)} min late`; t.skip = true; }
    T.push(t);
  }
  T.sort((a, b) => a.e - b.e || a.s.depth - b.s.depth);
  const net = p => Math.max(-1, p.pv / p.pe - 1 - 2 * (cfg.fee + p.slip));
  let cash = cfg.startEquity, open = []; const closed = [];
  const release = upto => { open = open.filter(p => { if (p.x <= upto && p.pv != null) { p.net = net(p); p.pnl = p.size * p.net; cash += p.size * (1 + p.net); p.st = 'CLOSED'; closed.push(p); return false; } return true; }); };
  for (const t of T) {
    if (t.skip) continue;
    release(t.e);
    if (t.e > now || t.pe == null) continue;
    if (open.some(p => p.sym === t.sym)) { t.st = 'SKIPPED: already in coin'; continue; }
    const used = open.reduce((a, p) => a + p.size, 0), eq = cash + used;
    if (open.length >= cfg.maxPos) { t.st = 'SKIPPED: max positions'; continue; }
    const size = Math.min(cfg.frac * eq, cfg.maxExp * eq - used, cash);
    if (size < 0.25 * cfg.frac * eq) { t.st = 'SKIPPED: exposure cap'; continue; }
    cash -= size; t.size = size; t.st = 'OPEN'; open.push(t);
  }
  release(now);
  let eq = cash;
  for (const p of open) { const last = live[p.sym] || p.pe; p.unreal = Math.max(-1, last / p.pe - 1 - 2 * (cfg.fee + p.slip)); eq += p.size * (1 + p.unreal); }
  return { T, closed, open, eq };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let user = {}; try { user = JSON.parse(fs.readFileSync(CFGP, 'utf8')); } catch (e) {}
  const now = Date.now();
  if (!user.startMs) { user.startMs = now; fs.writeFileSync(CFGP, JSON.stringify(user, null, 2) + '\n'); log('paper account starts now'); }
  const cfg = Object.assign({}, D, user);
  let st = { sigs: [], eqLog: [] }; try { st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch (e) {}
  const sigs = st.sigs || [];

  const tick = await jget('/api/v3/ticker/24hr'), tk = {}, live = {};
  for (const t of tick) { tk[t.symbol] = t; live[t.symbol] = +t.lastPrice; }
  const btcRows = await kl('BTCUSDT', 72), btc = btcRows.filter(r => r[6] < now), L = btc.length - 1;
  const bc = btc.map(r => +r[4]), bt = btc.map(r => r[0]), r24 = k => k >= 24 ? bc[k] / bc[k - 24] - 1 : NaN;
  const ks = []; for (let k = Math.max(24, L - cfg.lookbackH + 1); k <= L; k++) if (r24(k) <= -cfg.btcDrop) ks.push(k);
  const fresh = [];
  if (ks.length) {
    const cand = tick.map(t => t.symbol).filter(s => {
      if (!s.endsWith('USDT') || s === 'BTCUSDT') return false;
      const b = s.slice(0, -4); if (STABLE.has(b)) return false;
      for (const suf of ['UP', 'DOWN', 'BULL', 'BEAR']) if (b.endsWith(suf) && live[b.slice(0, -suf.length) + 'USDT'] !== undefined) return false;
      return +tk[s].quoteVolume >= cfg.minVol && +tk[s].priceChangePercent <= -10;
    });
    log(`BTC crash mode: ${cand.length} candidate coins`);
    const res = await pool(cand, 6, s => kl(s, 60));
    cand.forEach((s, j) => {
      const rows = res[j]; if (!rows) return;
      const idx = new Map(rows.map((r, i) => [r[0], i]));
      for (const k of ks) {
        const i = idx.get(bt[k]); if (i === undefined || i < 24) continue;
        const d = +rows[i][4] / +rows[i - 24][4] - 1; if (!(d <= -cfg.coinDrop)) continue;
        const entryMs = bt[k] + H; if (entryMs < cfg.startMs) break;
        if (sigs.some(x => x.sym === s && x.entryMs + cfg.hold * H > entryMs)) break;
        const o = { id: s + '|' + bt[k], sym: s, entryMs, depth: d, btc: r24(k), firstSeen: now, fsPrice: live[s], tested: TESTED.has(s.slice(0, -4)), px: {} };
        sigs.push(o); fresh.push(o); break;
      }
    });
  }
  // fill in prices that are now known (entry/exit candle opens)
  const jobs = [];
  for (const s of sigs) {
    const need = [['be', s.entryMs], ['bx', s.entryMs + cfg.hold * H], ['he', s.entryMs + H], ['hx', s.entryMs + (cfg.hold + 1) * H], ['lx', s.entryMs + cfg.hold * H]];
    for (const [f, ms] of need) if (s.px[f] == null && ms <= now) jobs.push([s, f, ms]);
  }
  await pool(jobs, 6, async ([s, f, ms]) => {
    let v = await openAt(s.sym, ms);
    if (v == null && f.endsWith('x') && now - ms > 6 * H && live[s.sym] === undefined) { v = 0; s.wipe = true; } // coin vanished: count as total loss
    if (v != null) s.px[f] = v;
  });

  const keys = ['base', 'harsh', 'live'], out = {}, eqNow = {};
  for (const k of keys) { out[k] = sim(cfg, sigs, k, now, live); eqNow[k] = Math.round(out[k].eq * 100) / 100; }
  const fp = crypto.createHash('md5').update(JSON.stringify(sigs) + keys.map(k => out[k].T.map(t => t.st).join()).join('|')).digest('hex');
  const eqLog = st.eqLog || [], lastE = eqLog[eqLog.length - 1];
  if (!lastE || keys.some(k => lastE[k] !== eqNow[k]) || now - lastE.t > 6 * H) eqLog.push(Object.assign({ t: now }, eqNow));
  const outSigs = sigs.map(s => Object.assign({}, s, { res: {} }));
  keys.forEach(k => out[k].T.forEach(t => {
    const o = outSigs.find(x => x.id === t.s.id); if (!o) return;
    o.res[k] = { st: t.st, e: t.e, x: t.x, pe: t.pe, pv: t.pv, size: t.size, net: t.net, pnl: t.pnl, unreal: t.unreal };
  }));
  const startEq = cfg.startEquity;
  const state = { updatedMs: now, fp, cfg: { startMs: cfg.startMs, startEquity: startEq, frac: cfg.frac, maxExp: cfg.maxExp, maxPos: cfg.maxPos, fee: cfg.fee, slipBase: cfg.slipBase, slipHarsh: cfg.slipHarsh, slipLive: cfg.slipLive, coinDrop: cfg.coinDrop, btcDrop: cfg.btcDrop, minVol: cfg.minVol, liveMaxLagMin: cfg.liveMaxLagMin },
    btc: { price: live.BTCUSDT, r24Bar: r24(L), r24Now: +tk.BTCUSDT.priceChangePercent / 100, gate: ks.length > 0 }, sigs: outSigs, eqLog: eqLog.slice(-4000) };
  const write = fp !== st.fp || now - (st.updatedMs || 0) > 2 * H || !fs.existsSync(path.join(DATA, 'state.json'));
  if (write) {
    fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(state));
    const rows = []; keys.forEach(k => out[k].closed.forEach(p => rows.push([new Date(p.x).toISOString(), k, p.sym, p.pe, p.pv, p.size.toFixed(2), (p.net * 100).toFixed(2), p.pnl.toFixed(2)].join(','))));
    fs.writeFileSync(path.join(DATA, 'closed_trades.csv'), 'exit_utc,account,coin,entry,exit,size_usd,net_pct,pnl_usd\n' + rows.join('\n') + '\n');
  }
  log(`BTC 24h ${(state.btc.r24Now * 100).toFixed(1)}% | ${sigs.length} signals | ${fresh.length} new | equity base ${eqNow.base} harsh ${eqNow.harsh} live ${eqNow.live} | ${write ? 'written' : 'unchanged'}`);
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tok && chat && fresh.length) {
    const txt = fresh.slice(0, 8).map(r => `BUY ${r.sym} ${(r.depth * 100).toFixed(0)}% in 24h (BTC ${(r.btc * 100).toFixed(1)}%) price ${r.fsPrice}`).join('\n');
    try { await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: 'Crash Buyer PAPER signals (hold 24h)\n' + txt }) }); } catch (e) { log('telegram failed'); }
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
