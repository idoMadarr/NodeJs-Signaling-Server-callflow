import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import type { AppConfig } from '../config';
import type { IceServer } from '../protocol';

export const newSecret = () => randomBytes(32).toString('base64url');
export const newToken = () => randomBytes(16).toString('base64url');
export const newCode = () => randomInt(0, 1_000_000).toString().padStart(6, '0');

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * STUN plus, when configured, TURN with time-limited credentials
 * (coturn `use-auth-secret`: username = "<expiry>:<id>", password = base64(HMAC-SHA1(secret, username))).
 */
export function iceServersFor(deviceId: string, cfg: AppConfig, now = Date.now()): IceServer[] {
  const servers: IceServer[] = [{ urls: cfg.stunUrls }];
  if (cfg.turn.secret && cfg.turn.urls.length) {
    const expiry = Math.floor(now / 1000) + cfg.turn.ttlSeconds;
    const username = `${expiry}:${deviceId}`;
    const credential = createHmac('sha1', cfg.turn.secret).update(username).digest('base64');
    servers.push({ urls: cfg.turn.urls, username, credential });
  }
  return servers;
}

/** Fixed-window limiter, in memory. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns false when the key is over its limit. */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size > 10_000) this.sweep(t);
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
