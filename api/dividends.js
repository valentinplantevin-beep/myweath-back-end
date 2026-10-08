// api/dividends.js — rendement du dividende (12 derniers mois) via Yahoo Finance, comme /api/prices.
// Appel : GET /api/dividends?symbols=SAN.PA,AAPL,HSBA.L   (en-tête x-api-key = SYNC_SECRET)
// Réponse : { "SAN.PA": { yield: 3.9, annual: 4.12, price: 105.3, currency: "EUR", last: "2026-05-12" },
//             "ASML": { yield: 0, ... }, "XXX": { error: "Yahoo HTTP 429" } }
 
// Yahoo refuse les requêtes dont l'identifiant ne ressemble pas à un vrai navigateur.
// Chaque appel réseau est limité dans le temps : Vercel coupe la fonction à 10 s, sans en-têtes CORS (l'app verrait « Failed to fetch »).
const TO = ms => AbortSignal.timeout(ms);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
 
async function one(symbol) {
  let lastErr = 'inconnu';
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9' }, signal: TO(4000) });
      if (!r.ok) { lastErr = `Yahoo HTTP ${r.status}`; continue; }
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.meta) { lastErr = (j && j.chart && j.chart.error && j.chart.error.description) || 'symbole introuvable'; continue; }
      const price = res.meta.regularMarketPrice;
      if (!(price > 0)) { lastErr = 'pas de cours'; continue; }
      const divs = Object.values((res.events && res.events.dividends) || {});
      // 12 derniers mois (+ 20 jours de marge pour un versement annuel légèrement décalé)
      const cutoff = Date.now() / 1000 - (365 + 20) * 86400;
      const recent = divs.filter(d => d && d.date >= cutoff && d.amount > 0);
      const annual = recent.reduce((s, d) => s + d.amount, 0);
      const last = divs.length ? new Date(Math.max(...divs.map(d => d.date)) * 1000).toISOString().slice(0, 10) : null;
      return {
        n12: recent.length,   // versements sur 12 mois (pour comprendre un 0 %)
        n: divs.length,       // versements sur 2 ans
        yield: Math.round((annual / price) * 10000) / 100, // en %, 2 décimales (cours et dividendes dans la même unité, même en pence)
        annual: Math.round(annual * 10000) / 10000,
        price,
        currency: res.meta.currency || null,
        last,
        payments: recent.sort((x, y) => x.date - y.date).map(x => ({ d: new Date(x.date * 1000).toISOString().slice(0, 10), a: Math.round(x.amount * 10000) / 10000 })),
      };
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 80);
    }
  }
  return { error: lastErr };
}
 
 
// ---- Dividende PRÉVISIONNEL (forward) : celui que Yahoo affiche sur sa fiche (dividendRate) ----
// Yahoo exige un « crumb » (jeton) + un cookie pour cette route. On les récupère une fois et on les garde en mémoire.
let _auth = null;
async function getAuth() {
  if (_auth && Date.now() - _auth.t < 30 * 60 * 1000) return _auth;
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: TO(3000) });
  let cookies = [];
  if (r1.headers.getSetCookie) cookies = r1.headers.getSetCookie();
  else if (r1.headers.get('set-cookie')) cookies = [r1.headers.get('set-cookie')];
  const cookie = cookies.map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('cookie Yahoo absent');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, signal: TO(3000) });
  if (!r2.ok) throw new Error('crumb HTTP ' + r2.status);
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 40 || /[<{]/.test(crumb)) throw new Error('crumb invalide');
  _auth = { cookie, crumb, t: Date.now() };
  return _auth;
}
// ---- P/FFO estimé (REITs) : FFO ≈ résultat net + amortissements − plus-values de cession d'immeubles (derniers comptes annuels) ----
// Yahoo ne publie pas le FFO : c'est une ESTIMATION à partir des comptes. Renvoie le P/FFO, ou null si les données manquent.
async function estimateFfo(sym, info) {
  if (!info || !(info.shares > 0) || !(info.price > 0)) return null;
  const types = ['annualNetIncome', 'annualNetIncomeCommonStockholders', 'annualDepreciationAndAmortization', 'annualDepreciationAmortizationDepletion', 'annualGainOnSaleOfPPE', 'annualGainOnSaleOfProperty', 'annualGainOnSaleOfBusiness'];
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 3 * 365 * 86400;
  const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?type=${types.join(',')}&period1=${p1}&period2=${p2}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: TO(3500) });
  if (!r.ok) return null;
  const j = await r.json();
  const last = {};
  for (const e of (j && j.timeseries && j.timeseries.result) || []) {
    const t = e.meta && e.meta.type && e.meta.type[0];
    const arr = t && e[t];
    if (!arr || !arr.length) continue;
    const v = arr.filter(x => x && x.reportedValue && isFinite(x.reportedValue.raw)).pop();
    if (v) last[t] = v.reportedValue.raw;
  }
  const ni = last.annualNetIncome ?? last.annualNetIncomeCommonStockholders;
  const da = last.annualDepreciationAndAmortization ?? last.annualDepreciationAmortizationDepletion ?? 0;
  const gain = last.annualGainOnSaleOfProperty ?? last.annualGainOnSaleOfPPE ?? 0;
  if (!isFinite(ni)) return null;
  const ffoPerShare = (ni + da - gain) / info.shares;
  if (!(ffoPerShare > 0)) return null;
  // Comptes et cours doivent être dans la même devise (le cours de Londres est en pence)
  const norm = c => (c === 'GBp' || c === 'GBX') ? 'GBP' : c;
  if (info.fcur && info.cur && norm(info.fcur) !== norm(info.cur)) return null;
  const priceMain = (info.cur === 'GBp' || info.cur === 'GBX') ? info.price / 100 : info.price;
  const ratio = priceMain / ffoPerShare;
  return ratio > 0 && ratio < 200 ? Math.round(ratio * 10) / 10 : null;
}
// Renvoie { SYMBOLE: { rate, yield } } (yield en %), ou lève une erreur lisible.
async function forwardInfo(symbols) {
  const out = {};
  const a = await getAuth();
  for (const host of ['query1', 'query2']) {
    const url = `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(a.crumb)}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: a.cookie, Accept: 'application/json' }, signal: TO(3500) });
    if (r.status === 401 || r.status === 403) { _auth = null; throw new Error('quote HTTP ' + r.status); }
    if (!r.ok) continue;
    const j = await r.json();
    for (const q of (j && j.quoteResponse && j.quoteResponse.result) || []) {
      const rate = q.dividendRate, price = q.regularMarketPrice;
      const pe = q.trailingPE > 0 ? Math.round(q.trailingPE * 10) / 10 : null; // PER (12 derniers mois) ; absent pour les ETF et les sociétés en perte
      const extra = { shares: q.sharesOutstanding, price, cur: q.currency, fcur: q.financialCurrency };
      if (!(rate > 0) || !(price > 0)) { out[q.symbol] = { rate: 0, yield: 0, pe, ...extra }; continue; }
      // Londres : le cours est en pence (GBp) et le dividende prévisionnel parfois en livres → l'unité est tranchée plus bas
      out[q.symbol] = { rate, yield: rate / price * 100, pence: q.currency === 'GBp' || q.currency === 'GBX', pe, ...extra };
    }
    return out;
  }
  throw new Error('quote indisponible');
}
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Authentification : en-tête x-api-key (utilisé par l'app) ou ?secret=... (pour tester dans un navigateur)
  const given = req.headers['x-api-key'] || req.query.secret;
  if (!process.env.SYNC_SECRET || given !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  const symbols = String(req.query.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  if (!symbols.length) return res.status(400).json({ error: 'symbols manquant' });
 
  const wantFfo = new Set(String(req.query.ffo || '').split(',').map(x => x.trim()).filter(Boolean));
  const t0 = Date.now();
  const out = {};
  // 6 requêtes en parallèle au maximum
  for (let i = 0; i < symbols.length; i += 6) {
    const batch = symbols.slice(i, i + 6);
    const results = await Promise.all(batch.map(s => one(s).catch(e => ({ error: String(e.message || e).slice(0, 80) }))));
    batch.forEach((s, k) => { out[s] = results[k]; });
  }
  // Dividende prévisionnel : remplace le rendement « 12 derniers mois » quand Yahoo le fournit
  let fwdErr = null;
  try {
    const ok = Object.keys(out).filter(s => out[s] && !out[s].error);
    if (Date.now() - t0 > 5000) throw new Error('trop lent, prévisionnel sauté');
    if (ok.length) {
      const fw = await forwardInfo(ok);
      for (const s of ok) {
        out[s].trailingYield = out[s].yield;
        const f = fw[s];
        out[s].pe = (f && f.pe > 0) ? f.pe : null;
        if (wantFfo.has(s)) { try { out[s].pffo = await estimateFfo(s, f); } catch (e) { out[s].pffo = null; } }
        if (f && f.rate > 0) {
          // On essaie y, y×100 et y/100 ; on garde celui qui colle le mieux au rendement des 12 mois passés
          // (ou, à défaut, une valeur plausible : pour une action de Londres en pence, le dividende est en livres → ×100).
          let y = f.yield;
          const cands = [y, y * 100, y / 100].filter(v => v > 0 && v <= 25);
          const t = out[s].trailingYield;
          if (t > 0 && cands.length) y = cands.reduce((b, v) => Math.abs(Math.log(v / t)) < Math.abs(Math.log(b / t)) ? v : b);
          else if (f.pence && y * 100 <= 25) y = y * 100;
          else if (!cands.includes(y)) y = cands.length ? cands[0] : 0;
          if (y > 0) { out[s].yield = Math.round(y * 100) / 100; out[s].annual = f.rate; out[s].basis = 'forward'; }
          else out[s].basis = 'trailing';
        }
        else out[s].basis = 'trailing';
      }
    }
  } catch (e) {
    fwdErr = String(e.message || e).slice(0, 80);
    for (const s of Object.keys(out)) if (out[s] && !out[s].error) { out[s].basis = 'trailing'; out[s].forwardError = fwdErr; }
  }
  res.setHeader('Cache-Control','no-store');
  res.status(200).json(out);
}
