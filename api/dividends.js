// api/dividends.js — rendement du dividende (12 derniers mois) via Yahoo Finance, comme /api/prices.
// Appel : GET /api/dividends?symbols=SAN.PA,AAPL,HSBA.L   (en-tête x-api-key = SYNC_SECRET)
// Réponse : { "SAN.PA": { yield: 3.9, annual: 4.12, price: 105.3, currency: "EUR", last: "2026-05-12" },
//             "ASML": { yield: 0, ... }, "XXX": null }   (null = symbole introuvable chez Yahoo)
 
const UA = 'Mozilla/5.0 (compatible; CapX/1.0)';
 
async function one(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.meta) return null;
  const price = res.meta.regularMarketPrice;
  if (!(price > 0)) return null;
  const divs = Object.values((res.events && res.events.dividends) || {});
  // 12 derniers mois (+ 20 jours de marge pour un versement annuel légèrement décalé)
  const cutoff = Date.now() / 1000 - (365 + 20) * 86400;
  const recent = divs.filter(d => d && d.date >= cutoff && d.amount > 0);
  const annual = recent.reduce((s, d) => s + d.amount, 0);
  const last = divs.length ? new Date(Math.max(...divs.map(d => d.date)) * 1000).toISOString().slice(0, 10) : null;
  return {
    n12: recent.length,   // nombre de versements sur 12 mois (pour comprendre un résultat à 0 %)
    n: divs.length,       // nombre de versements sur 2 ans
    yield: Math.round((annual / price) * 10000) / 100, // en %, 2 décimales (le prix et les dividendes sont dans la même unité, même en pence)
    annual: Math.round(annual * 10000) / 10000,
    price,
    currency: res.meta.currency || null,
    last,
  };
}
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers['x-api-key'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  const symbols = String(req.query.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  if (!symbols.length) return res.status(400).json({ error: 'symbols manquant' });
 
  const out = {};
  // 6 requêtes en parallèle au maximum
  for (let i = 0; i < symbols.length; i += 6) {
    const batch = symbols.slice(i, i + 6);
    const results = await Promise.all(batch.map(s => one(s).catch(() => null)));
    batch.forEach((s, k) => { out[s] = results[k]; });
  }
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.status(200).json(out);
}
