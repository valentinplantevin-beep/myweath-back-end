import { sql } from '@vercel/postgres';

async function fetchYahooPrice(symbol) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await r.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return (typeof price === 'number' && price > 0) ? price : null;
  } catch {
    return null;
  }
}

function buildYahooSymbol(asset) {
  if (!asset.ticker) return null;
  if (asset.category === 'crypto') return `${asset.ticker.toUpperCase()}-USD`;
  if (['actions', 'etf', 'pension'].includes(asset.category)) return asset.ticker;
  return null; // commodités : pas de correspondance fiable connue pour l'instant, dernier prix conservé
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  const { rows } = await sql`SELECT value FROM portfolio_data WHERE key = 'assets'`;
  const assets = rows[0]?.value || [];

  let total = 0;
  const byCat = {};

  for (const a of assets) {
    if (a.category === 'dette') continue;

    let price = a.currentPrice || 0;
    const symbol = buildYahooSymbol(a);
    if (symbol) {
      const live = await fetchYahooPrice(symbol);
      if (live) price = live;
      await new Promise(r => setTimeout(r, 300)); // reste courtois envers Yahoo Finance
    }

    const value = (a.quantity || 1) * price;
    total += value;
    byCat[a.category] = (byCat[a.category] || 0) + value;
  }

  const today = new Date().toISOString().slice(0, 10);
  await sql`
    INSERT INTO history (date, total, by_cat)
    VALUES (${today}, ${total}, ${JSON.stringify(byCat)})
    ON CONFLICT (date) DO UPDATE SET total = ${total}, by_cat = ${JSON.stringify(byCat)}
  `;

  res.status(200).json({ ok: true, date: today, total });
}
