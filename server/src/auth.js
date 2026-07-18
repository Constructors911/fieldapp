// PIN hashing for employee sign-in. scrypt with per-employee salt.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPin(pin, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
}

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
