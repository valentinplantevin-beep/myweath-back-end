
// Outils partagés par /api/auth et /api/data (le préfixe « _ » dit à Vercel que ce n'est pas une page).
import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
 
export const sql = neon(process.env.POSTGRES_URL);
 
export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}
 
let ready = null;
export function ensureTables() {
  if (!ready) {
    ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS capx_accounts (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        salt TEXT NOT NULL,
        pw_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS capx_kv (
        account_id INTEGER NOT NULL,
        k TEXT NOT NULL,
        v TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (account_id, k)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS capx_versions (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL,
        k TEXT NOT NULL,
        v TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        archived_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
 
// ---- mots de passe (scrypt, intégré à Node : rien à installer) ----
export function newSalt() { return crypto.randomBytes(16).toString('hex'); }
export function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
export function checkPassword(pw, salt, hash) {
  const a = Buffer.from(hashPassword(pw, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
 
// ---- jeton de connexion (signé avec SYNC_SECRET : aucune variable de plus à créer) ----
const b64 = (s) => Buffer.from(s).toString('base64url');
function sign(payload) {
  return crypto.createHmac('sha256', String(process.env.SYNC_SECRET || '')).update('capx-token-v1.' + payload).digest('base64url');
}
export function makeToken(accountId, days = 90) {
  const payload = b64(JSON.stringify({ a: accountId, exp: Date.now() + days * 86400000 }));
  return payload + '.' + sign(payload);
}
export function readToken(req) {
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [payload, sig] = t.split('.');
  if (!payload || !sig || !process.env.SYNC_SECRET) return null;
  const good = sign(payload);
  const A = Buffer.from(sig), B = Buffer.from(good);
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!p.a || !p.exp || p.exp < Date.now()) return null;
    return p.a;
  } catch (e) { return null; }
}
