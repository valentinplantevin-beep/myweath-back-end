// GET /api/config  (connexion requise) → les clés d'accès que l'app utilise, lues dans les variables Vercel.
// Ainsi elles ne sont écrites nulle part dans la page publique de l'app.
import { cors, readToken } from './_lib.js';
 
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!readToken(req)) return res.status(401).json({ error: 'Connexion requise' });
  return res.status(200).json({
    finnhub: process.env.FINNHUB_KEY || '',
    fmp: process.env.FMP_KEY || '',
    backend: process.env.SYNC_SECRET || ''
  });
}
