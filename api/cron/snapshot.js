import { sql } from '@vercel/postgres';

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
    const value = (a.quantity || 1) * (a.currentPrice || 0);
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
