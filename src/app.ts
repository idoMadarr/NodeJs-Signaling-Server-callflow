import http from 'http';
import { randomUUID } from 'crypto';
import express, { Request, Response } from 'express';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { AppConfig } from './config';
import { openDb } from './db';
import type { ClientToServerEvents, ServerToClientEvents } from './protocol';
import { hashSecret, newSecret, RateLimiter } from './services/security';
import { attachSignaling } from './services/signaling';

const registerSchema = z
  .object({
    role: z.enum(['camera', 'viewer']),
    name: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export function createServer(cfg: AppConfig) {
  const db = openDb(cfg.dbPath);
  const registerLimiter = new RateLimiter(cfg.registrationsPerHour, 60 * 60 * 1000);

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  /** Registers a device. The secret is returned once; only its hash is stored. */
  app.post('/v2/devices', (req: Request, res: Response) => {
    if (!registerLimiter.take(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'rate-limited' });
      return;
    }
    const body = registerSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid-request' });
      return;
    }

    const deviceId = randomUUID();
    const secret = newSecret();
    const { role } = body.data;
    const name = body.data.name ?? (role === 'camera' ? 'Camera' : 'Viewer');
    db.insertDevice({ id: deviceId, secretHash: hashSecret(secret), role, name });
    res.status(201).json({ deviceId, secret });
  });

  const httpServer = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  attachSignaling(io.of('/v2'), db, cfg);

  return {
    listen(port = cfg.port) {
      return new Promise<number>(resolve => {
        httpServer.listen(port, () => {
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    async close() {
      await io.close(); // also closes httpServer
      db.close();
    },
  };
}
