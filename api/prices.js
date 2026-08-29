export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.headers['x-api-key'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const tickers = (req.query.tickers || '').split(',').filter(Boolean);
  const results = {};

  for (const symbol of tickers) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await r.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === 'number') results[symbol] = price;
    } catch (e) {
      console.error(`Échec cours ${symbol}`, e.message);
    }
  }

  res.status(200).json(results);
}
