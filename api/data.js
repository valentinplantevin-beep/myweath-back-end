// GET  /api/data                         → { items: { clé: { v, t } }, now }
// POST /api/data { items: [{k, v, t}] }  → { accepted: [...], rejected: [...] }
// Chaque clé est une donnée de l'app (actifs, objectifs, budget… de chaque utilisateur). t = date de modification (ms).
// Règle : la version la plus récente gagne. L'ancienne version est archivée (10 dernières conservées).
import { sql, cors, ensureTables, readToken } from './_lib.js';
 
const KEY_OK = /^(profiles|(pf_[a-z0-9]+__)?patrimoine-(assets|history|savings-items|income|budget|goals|personal-info|profile))$/;
const MAX_VALUE = 3 * 1024 * 1024;
 
export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureTables();
    const account = readToken(req);
    if (!account) return res.status(401).json({ error: 'Connexion requise' });
 
    if (req.method === 'GET') {
      const rows = await sql`SELECT k, v, updated_at FROM capx_kv WHERE account_id = ${account}`;
      const items = {};
      rows.forEach((r) => { items[r.k] = { v: r.v, t: Number(r.updated_at) }; });
      return res.status(200).json({ items, now: Date.now() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
 
    const list = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 60) : [];
    const accepted = [], rejected = [];
    for (const it of list) {
      if (!it || typeof it.k !== 'string' || !KEY_OK.test(it.k) || typeof it.v !== 'string' || it.v.length > MAX_VALUE || !(Number(it.t) > 0)) {
        rejected.push(it && it.k); continue;
      }
      const t = Math.min(Number(it.t), Date.now() + 5 * 60000); // une horloge très en avance ne doit pas bloquer les autres
      const cur = await sql`SELECT v, updated_at FROM capx_kv WHERE account_id = ${account} AND k = ${it.k}`;
      if (cur.length && Number(cur[0].updated_at) >= t) { rejected.push(it.k); continue; }
      if (cur.length && cur[0].v !== it.v) {
        await sql`INSERT INTO capx_versions (account_id, k, v, updated_at) VALUES (${account}, ${it.k}, ${cur[0].v}, ${cur[0].updated_at})`;
        await sql`DELETE FROM capx_versions WHERE account_id = ${account} AND k = ${it.k}
                  AND id NOT IN (SELECT id FROM capx_versions WHERE account_id = ${account} AND k = ${it.k} ORDER BY id DESC LIMIT 10)`;
      }
      await sql`INSERT INTO capx_kv (account_id, k, v, updated_at) VALUES (${account}, ${it.k}, ${it.v}, ${t})
                ON CONFLICT (account_id, k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at`;
      accepted.push(it.k);
    }
    return res.status(200).json({ accepted, rejected });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
