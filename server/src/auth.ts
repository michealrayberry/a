/**
 * Authentication + role-based authorization (blueprint §4, §13.1).
 *
 * CRITICAL: authority is NEVER derived from a client-sent role or a hardcoded
 * email. The JWT is signed server-side; every request re-reads the user's role
 * from the trusted database. See requireRole().
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { DB } from './db.js';
import { newId } from './ids.js';
import { nowIso, type Clock, systemClock } from './time.js';

export type Role = 'PARTICIPANT' | 'AP' | 'TECH_ADMIN';

export interface UserRow {
  id: string;
  displayName: string;
  email: string;
  passwordHash: string;
  role: Role;
  status: string;
  publicIdentityAllowed: number;
}

function secret(): string {
  return process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me';
}

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

export function createUser(
  db: DB,
  input: { displayName: string; email: string; password: string; role: Role; publicIdentityAllowed?: boolean },
  clock: Clock = systemClock,
): UserRow {
  const id = newId('usr');
  db.prepare(
    `INSERT INTO users (id, displayName, email, passwordHash, role, status, publicIdentityAllowed, createdAt)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
  ).run(
    id,
    input.displayName,
    input.email.toLowerCase(),
    hashPassword(input.password),
    input.role,
    input.publicIdentityAllowed ? 1 : 0,
    nowIso(clock),
  );
  return getUserById(db, id)!;
}

export function getUserById(db: DB, id: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function login(
  db: DB,
  email: string,
  password: string,
  clock: Clock = systemClock,
): { token: string; user: UserRow } | null {
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase()) as
    | UserRow
    | undefined;
  if (!user || user.status !== 'ACTIVE') return null;
  if (!bcrypt.compareSync(password, user.passwordHash)) return null;
  db.prepare(`UPDATE users SET lastLoginAt = ? WHERE id = ?`).run(nowIso(clock), user.id);
  // The token carries only identity; role is re-read server-side on each request.
  const token = jwt.sign({ sub: user.id }, secret(), { expiresIn: '12h' });
  return { token, user };
}

export interface AuthedRequest extends Request {
  user?: UserRow;
}

/** Attach the trusted user (from DB) based on a verified token. */
export function authenticate(db: DB) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthenticated' });
    try {
      const payload = jwt.verify(header.slice(7), secret()) as { sub: string };
      const user = getUserById(db, payload.sub);
      if (!user || user.status !== 'ACTIVE') return res.status(401).json({ error: 'unauthenticated' });
      req.user = user; // role comes from the DB, not the token
      next();
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
  };
}

/** Authorize by role. Enforced server-side on every protected route. */
export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', requiredRoles: roles });
    }
    next();
  };
}
