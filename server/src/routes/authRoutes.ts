import { Router } from 'express';
import type { DB } from '../db.js';
import { login } from '../auth.js';
import type { Clock } from '../time.js';

export function authRouter(db: DB, clock: Clock): Router {
  const r = Router();
  r.post('/login', (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    const result = login(db, email, password, clock);
    if (!result) return res.status(401).json({ error: 'invalid_credentials' });
    const { token, user } = result;
    res.json({
      token,
      user: { id: user.id, displayName: user.displayName, role: user.role },
    });
  });
  return r;
}
