// POST /api/auth  { action: 'register' | 'login', email, password, setupCode? }  → { token, email }
// Création de compte : possible plusieurs fois, avec le code d'invitation (SYNC_SECRET).
// GET  /api/auth  → { hasAccount: true|false }
import { sql, cors, ensureTables, newSalt, hashPassword, checkPassword, makeToken } from './_lib.js';
 
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
 
export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureTables();
    if (req.method === 'GET') {
      const rows = await sql`SELECT COUNT(*)::int AS n FROM capx_accounts`;
      return res.status(200).json({ hasAccount: rows[0].n > 0 });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
 
    const { action, email, password, setupCode } = req.body || {};
    const mail = String(email || '').trim().toLowerCase();
    if (!mail || !mail.includes('@') || !password) return res.status(400).json({ error: 'E-mail et mot de passe requis' });
 
    if (action === 'register') {
      if (!process.env.SYNC_SECRET || setupCode !== process.env.SYNC_SECRET) {
        await wait(600);
        return res.status(403).json({ error: 'Code de configuration incorrect' });
      }
      if (String(password).length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
      // Plusieurs comptes possibles : chacun est protégé par le même code d'invitation (SYNC_SECRET).
      const dup = await sql`SELECT 1 FROM capx_accounts WHERE email = ${mail}`;
      if (dup.length) return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail. Connectez-vous.' });
      const salt = newSalt();
      const hash = hashPassword(password, salt);
      const first = await sql`SELECT COUNT(*)::int AS n FROM capx_accounts`;
      const ins = await sql`INSERT INTO capx_accounts (email, salt, pw_hash) VALUES (${mail}, ${salt}, ${hash}) RETURNING id`;
      return res.status(200).json({ token: makeToken(ins[0].id), email: mail, admin: first[0].n === 0 });
    }
 
    if (action === 'login') {
      const rows = await sql`SELECT id, salt, pw_hash FROM capx_accounts WHERE email = ${mail}`;
      if (!rows.length || !checkPassword(password, rows[0].salt, rows[0].pw_hash)) {
        await wait(700);
        return res.status(401).json({ error: 'E-mail ou mot de passe incorrect' });
      }
      const mn = await sql`SELECT MIN(id)::int AS m FROM capx_accounts`;
      return res.status(200).json({ token: makeToken(rows[0].id), email: mail, admin: rows[0].id === mn[0].m });
    }
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
