import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Optional password protection, enabled by setting CLIPFORGE_PASSWORD.
 * Required whenever ClipForge listens beyond localhost (phone on Wi-Fi, Tailscale, a server),
 * because anyone who can reach it could otherwise spend your Claude usage.
 *
 * Sessions are an HMAC of a per-install secret, so they survive restarts and are invalidated
 * by changing the password.
 */
const COOKIE = 'cf_session';
const MAX_AGE_S = 30 * 24 * 3600;

export function createAuth({ password, secretFile }) {
  const enabled = Boolean(password);
  let secret = '';
  if (enabled) {
    try {
      secret = fsSync.readFileSync(secretFile, 'utf8').trim();
    } catch {
      secret = crypto.randomBytes(32).toString('hex');
      fsSync.mkdirSync(path.dirname(secretFile), { recursive: true });
      fsSync.writeFileSync(secretFile, secret, { mode: 0o600 });
    }
  }
  const token = enabled ? crypto.createHmac('sha256', secret).update(`v1:${password}`).digest('hex') : '';
  const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const readCookie = (req) =>
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === COOKIE)?.[1];
  const isAuthed = (req) => !enabled || safeEqual(readCookie(req) || '', token);

  // Simple brute-force brake: 10 failed attempts per IP per 10 minutes.
  const attempts = new Map();
  const tooMany = (ip) => {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    attempts.set(ip, list);
    return list.length >= 10;
  };

  return {
    enabled,
    isAuthed,
    /** Express middleware guarding /api (except the login endpoints). */
    guard(req, res, next) {
      if (isAuthed(req)) return next();
      res.status(401).json({ error: 'Log in first.', auth: true });
    },
    status(req, res) {
      res.json({ enabled, authed: isAuthed(req) });
    },
    login(req, res) {
      if (!enabled) return res.json({ ok: true });
      const ip = req.ip || req.socket.remoteAddress || '?';
      if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts — wait 10 minutes.' });
      if (!safeEqual(String(req.body?.password || ''), password)) {
        attempts.get(ip).push(Date.now());
        return res.status(401).json({ error: 'Wrong password.' });
      }
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
      );
      res.json({ ok: true });
    },
    logout(_req, res) {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
      res.json({ ok: true });
    },
  };
}
