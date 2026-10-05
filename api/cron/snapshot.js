import { neon } from '@neondatabase/serverless';
 
const sql = neon(process.env.POSTGRES_URL);
 
// ---------- Même logique de calcul que l'app (valeurs, dettes, crédits, fraction de propriété) ----------
function ownershipFactor(a) {
  if (a.category !== 'immo') return 1;
  return (a.ownershipPct != null && a.ownershipPct > 0 && a.ownershipPct <= 100) ? a.ownershipPct / 100 : 1;
}
function makeCalc(rates) {
  const rate = (a) => rates[(a.currency || 'GBP').toUpperCase()] ?? 1;
  const valueBase = (a) => a.quantity * a.currentPrice * rate(a) * ownershipFactor(a);
  const netValueBase = (a) => {
    const v = valueBase(a);
    if (a.category === 'immo' && a.mortgageRemaining) {
      return v - a.mortgageRemaining * ownershipFactor(a) * rate(a);
    }
    return v;
  };
  const totalDebts = (list) => {
    const explicit = list.filter(a => a.category === 'dette').reduce((s, a) => s + valueBase(a), 0);
    const mortgages = list
      .filter(a => a.category === 'immo' && a.mortgageRemaining > 0)
      .reduce((s, a) => s + a.mortgageRemaining * ownershipFactor(a) * rate(a), 0);
    return explicit + mortgages;
  };
  const netWorth = (list) => {
    const assetsTotal = list.filter(a => a.category !== 'dette').reduce((s, a) => {
      if (a.category === 'immo') return s + valueBase(a);
      return s + netValueBase(a);
    }, 0);
    return assetsTotal - totalDebts(list);
  };
  return { netValueBase, netWorth };
}
 
// ---------- Prix du jour (Yahoo Finance), avec les mêmes garde-fous que l'app ----------
function yahooSymbol(a) {
  let sym = (a.ticker || '').trim();
  if (!sym) return null;
  if (a.category === 'crypto') return `${sym.toUpperCase()}-USD`;
  if (a.category === 'commodity') return null; // on garde le dernier prix connu
  if (!['actions', 'etf', 'pension'].includes(a.category)) return null;
  const ccy = (a.currency || '').toUpperCase();
  if (ccy === 'EUR') return a.yahooSymbol || (sym.includes('.') ? sym : null); // symbole Yahoo résolu par l'app (ex : SAN.PA)
  if (/[A-Za-z][a-z]$/.test(sym) && sym.length > 1) sym = sym.slice(0, -1);
  if (ccy === 'GBP') return `${sym}.L`;
  return sym; // USD : symbole tel quel
}
async function yahooPrice(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === 'number' && p > 0 ? p : null;
  } catch { return null; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function sane(raw, old) {
  if (!(old > 0)) return raw;
  const ok = (p) => p / old <= 5 && p / old >= 0.2;
  if (ok(raw)) return raw;
  if (ok(raw / 100)) return raw / 100; // Londres : Yahoo renvoie des pence, l'app compte en livres
  return null;
}
 
async function getRates(base) {
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${base}`);
    const j = await r.json();
    if (j && j.rates) {
      const out = { [base]: 1 };
      Object.keys(j.rates).forEach(c => { const per = parseFloat(j.rates[c]); if (per > 0) out[c.toUpperCase()] = 1 / per; });
      return out;
    }
  } catch { /* on tombe sur les taux sauvegardés */ }
  return null;
}
 
export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  const okBearer = auth === `Bearer ${process.env.CRON_SECRET}`;
  const okQuery = req.query && req.query.secret && req.query.secret === process.env.CRON_SECRET;
  if (!okBearer && !okQuery) return res.status(401).json({ error: 'Non autorisé' });
 
  try {
    const rowsA = await sql`SELECT value FROM portfolio_data WHERE key = 'assets'`;
    if (!rowsA.length) return res.status(200).json({ skipped: true, reason: 'aucun actif synchronisé' });
    let assets = rowsA[0].value;
    if (typeof assets === 'string') assets = JSON.parse(assets);
    if (!Array.isArray(assets) || !assets.length) return res.status(200).json({ skipped: true, reason: 'aucun actif' });
 
    let settings = {};
    try {
      const rowsS = await sql`SELECT value FROM portfolio_data WHERE key = 'settings'`;
      if (rowsS.length) settings = typeof rowsS[0].value === 'string' ? JSON.parse(rowsS[0].value) : rowsS[0].value;
    } catch { /* pas de réglages synchronisés */ }
    const base = (settings.baseCurrency || 'GBP').toUpperCase();
    const rates = (await getRates(base)) || settings.rates || { [base]: 1 };
 
    // Prix du jour, une seule requête par symbole
    const cache = {};
    const live = assets.map(a => ({ ...a }));
    let updated = 0, skipped = 0;
    for (const a of live) {
      const sym = yahooSymbol(a);
      if (!sym) continue;
      if (!(sym in cache)) { cache[sym] = await yahooPrice(sym); await sleep(300); }
      const raw = cache[sym];
      if (raw == null) { skipped++; continue; }
      const p = sane(raw, a.currentPrice);
      if (p == null) { skipped++; continue; }
      a.currentPrice = p;
      updated++;
    }
 
    // Même règle que l'app : un actif ajouté depuis moins de 24 h n'entre pas encore dans l'historique
    const now = Date.now();
    const counted = live.filter(a => !a.createdAt || now - a.createdAt >= 24 * 3600 * 1000);
    const calc = makeCalc(rates);
    const total = calc.netWorth(counted);
    const byCat = {};
    counted.forEach(a => { byCat[a.category] = (byCat[a.category] || 0) + calc.netValueBase(a); });
 
    const today = new Date().toISOString().slice(0, 10);
    const byCatJson = JSON.stringify(byCat);
    await sql`
      INSERT INTO history (date, total, by_cat)
      VALUES (${today}, ${total}, ${byCatJson}::jsonb)
      ON CONFLICT (date) DO UPDATE SET total = ${total}, by_cat = ${byCatJson}::jsonb
    `;
    res.status(200).json({ ok: true, date: today, total, base, pricesUpdated: updated, pricesSkipped: skipped });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

  res.status(200).json({ ok: true, date: today, total });
}
