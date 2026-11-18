import path from 'path';
import * as dotenv from 'dotenv';

export interface AppConfig {
  port: number;
  /** File path, or ':memory:' */
  dbPath: string;
  stunUrls: string[];
  turn: { secret: string; urls: string[]; ttlSeconds: number };
  pairingTtlMs: number;
  maxViewersPerCamera: number;
  /** pair:claim attempts per device per minute (protects 6-digit codes from guessing). */
  pairClaimPerMinute: number;
  /** POST /v2/devices per IP per hour. */
  registrationsPerHour: number;
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

export function loadConfig(): AppConfig {
  dotenv.config();
  const env = process.env;
  const stun = list(env.STUN_URLS);
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? path.join(process.cwd(), 'data', 'callflow.db'),
    stunUrls: stun.length ? stun : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    turn: { secret: env.TURN_SECRET ?? '', urls: list(env.TURN_URLS), ttlSeconds: 6 * 60 * 60 },
    pairingTtlMs: 5 * 60 * 1000,
    maxViewersPerCamera: 3,
    pairClaimPerMinute: 5,
    registrationsPerHour: 30,
  };
}
