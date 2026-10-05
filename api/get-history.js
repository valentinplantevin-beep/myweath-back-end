import { neon } from '@neondatabase/serverless';
 
const sql = neon(process.env.POSTGRES_URL);
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  if (req.headers['x-api-key'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
 
  try {
    const rows = await sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS date, total::float AS total, by_cat
      FROM history
      ORDER BY date ASC
    `;
    res.status(200).json(rows.map(r => ({ date: r.date, total: r.total, byCat: r.by_cat })));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
