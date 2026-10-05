// api/dividends.js — rendement du dividende (12 derniers mois) via Yahoo Finance, comme /api/prices.
// Appel : GET /api/dividends?symbols=SAN.PA,AAPL,HSBA.L   (en-tête x-api-key = SYNC_SECRET)
// Réponse : { "SAN.PA": { yield: 3.9, annual: 4.12, price: 105.3, currency: "EUR", last: "2026-05-12" },
//             "ASML": { yield: 0, ... }, "XXX": { error: "Yahoo HTTP 429" } }
 
// Yahoo refuse les requêtes dont l'identifiant ne ressemble pas à un vrai navigateur.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
 
async function one(symbol) {
  let lastErr = 'inconnu';
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
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
      };
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 80);
    }
  }
  return { error: lastErr };
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
 
  const out = {};
  // 6 requêtes en parallèle au maximum
  for (let i = 0; i < symbols.length; i += 6) {
    const batch = symbols.slice(i, i + 6);
    const results = await Promise.all(batch.map(s => one(s).catch(e => ({ error: String(e.message || e).slice(0, 80) }))));
    batch.forEach((s, k) => { out[s] = results[k]; });
  }
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.status(200).json(out);
}
