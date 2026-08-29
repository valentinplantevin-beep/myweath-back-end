import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.headers['x-api-key'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key et value requis' });
  }

  await sql`
    INSERT INTO portfolio_data (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(value)}, updated_at = NOW()
  `;

  res.status(200).json({ ok: true });
}
