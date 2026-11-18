import { randomUUID } from 'crypto';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { Db, DeviceRow } from '../db';
import type {
  AckResult,
  CameraStatus,
  CameraSummary,
  ClientToServerEvents,
  ErrorCode,
  Role,
  ServerToClientEvents,
  SessionEndReason,
  ViewerSummary,
} from '../protocol';
import { PairingInvites } from './pairing';
import { iceServersFor, RateLimiter, secretMatches } from './security';

interface SocketData {
  deviceId: string;
  role: Role;
  name: string;
}

type V2Namespace = Namespace<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
type V2Socket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

interface Session {
  id: string;
  cameraId: string;
  viewerId: string;
}

// ---- request validation -------------------------------------------------

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(40);

const schemas = {
  handshake: z.object({ deviceId: id, secret: z.string().min(1).max(128) }),
  deviceUpdate: z
    .object({ name: name.optional(), role: z.enum(['camera', 'viewer']).optional() })
    .strict(),
  pairClaim: z.union([
    z.object({ token: z.string().min(8).max(64) }).strict(),
    z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
  ]),
  peer: z.object({ peerId: id }).strict(),
  watchStart: z.object({ cameraId: id }).strict(),
  watchStop: z.object({ sessionId: id }).strict(),
  status: z
    .object({
      battery: z.number().min(0).max(1).optional(),
      charging: z.boolean().optional(),
      network: z.enum(['wifi', 'cellular', 'ethernet', 'unknown']).optional(),
    })
    .strict(),
  signal: z
    .object({
      sessionId: id,
      payload: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('description'),
          description: z.object({
            type: z.enum(['offer', 'answer']),
            sdp: z.string().max(100_000),
          }),
        }),
        z.object({
          kind: z.literal('candidate'),
          candidate: z
            .object({
              candidate: z.string().max(1_000),
              sdpMid: z.string().max(64).nullable(),
              sdpMLineIndex: z.number().int().min(0).max(64).nullable(),
            })
            .nullable(),
        }),
      ]),
    })
    .strict(),
};

const ok = <T>(data: T): AckResult<T> => ({ ok: true, data });
const fail = (error: ErrorCode): AckResult<never> => ({ ok: false, error });

/** Clients may call with a missing or non-function ack; never crash on that. */
function reply<T>(ack: unknown, result: AckResult<T>) {
  if (typeof ack === 'function') ack(result);
}

const room = (deviceId: string) => `dev:${deviceId}`;

// ---- namespace ----------------------------------------------------------

export function attachSignaling(nsp: V2Namespace, db: Db, cfg: AppConfig) {
  const invites = new PairingInvites(cfg.pairingTtlMs);
  const claimLimiter = new RateLimiter(cfg.pairClaimPerMinute, 60_000);
  const sessions = new Map<string, Session>();
  /** deviceId -> connected socket count */
  const presence = new Map<string, number>();
  /** cameraId -> last reported status */
  const statuses = new Map<string, CameraStatus>();

  const cameraSummary = (row: DeviceRow): CameraSummary => ({
    id: row.id,
    name: row.name,
    online: presence.has(row.id),
    status: statuses.get(row.id) ?? null,
    lastSeen: row.last_seen,
  });
  const viewerSummary = (row: DeviceRow): ViewerSummary => ({
    id: row.id,
    name: row.name,
  });

  function notifyViewers(cameraId: string) {
    const camera = db.getDevice(cameraId);
    const viewers = db.viewersForCamera(cameraId);
    if (!camera || !viewers.length) return;
    nsp.to(viewers.map(v => room(v.id))).emit('camera:update', cameraSummary(camera));
  }

  function endSession(session: Session, reason: SessionEndReason) {
    if (!sessions.delete(session.id)) return;
    nsp
      .to([room(session.cameraId), room(session.viewerId)])
      .emit('watch:ended', { sessionId: session.id, reason });
  }

  function endSessionsWhere(match: (s: Session) => boolean, reason: SessionEndReason) {
    for (const s of [...sessions.values()]) if (match(s)) endSession(s, reason);
  }

  // Authenticate every connection.
  nsp.use((socket, next) => {
    const auth = schemas.handshake.safeParse(socket.handshake.auth);
    const device = auth.success ? db.getDevice(auth.data.deviceId) : null;
    if (!auth.success || !device || !secretMatches(auth.data.secret, device.secret_hash)) {
      return next(new Error('unauthorized'));
    }
    socket.data = { deviceId: device.id, role: device.role, name: device.name };
    next();
  });

  nsp.on('connection', (socket: V2Socket) => {
    const me = socket.data.deviceId;
    const is = (role: Role) => socket.data.role === role;

    socket.join(room(me));
    presence.set(me, (presence.get(me) ?? 0) + 1);
    db.touch(me);
    if (is('camera')) notifyViewers(me);

    socket.on('device:update', (raw, ack) => {
      const req = schemas.deviceUpdate.safeParse(raw);
      if (!req.success) return reply(ack, fail('invalid-request'));
      const wasCamera = is('camera');
      socket.data.name = req.data.name ?? socket.data.name;
      socket.data.role = req.data.role ?? socket.data.role;
      db.updateDevice(me, socket.data.name, socket.data.role);
      if (wasCamera && !is('camera')) {
        invites.revoke(me);
        endSessionsWhere(s => s.cameraId === me, 'stopped');
      }
      if (wasCamera || is('camera')) notifyViewers(me);
      reply(ack, ok(null));
    });

    socket.on('ice:servers', ack => {
      reply(ack, ok(iceServersFor(me, cfg)));
    });

    // ---- pairing ----

    socket.on('pair:create', ack => {
      if (!is('camera')) return reply(ack, fail('forbidden'));
      reply(ack, ok(invites.create(me)));
    });

    socket.on('pair:claim', (raw, ack) => {
      if (!is('viewer')) return reply(ack, fail('forbidden'));
      if (!claimLimiter.take(me)) return reply(ack, fail('rate-limited'));
      const req = schemas.pairClaim.safeParse(raw);
      if (!req.success) return reply(ack, fail('invalid-request'));

      const cameraId = invites.consume(req.data);
      const camera = cameraId ? db.getDevice(cameraId) : null;
      if (!camera || camera.role !== 'camera' || camera.id === me) {
        return reply(ack, fail('invalid-code'));
      }
      db.pair(camera.id, me);
      nsp.to(room(camera.id)).emit('pair:claimed', { id: me, name: socket.data.name });
      reply(ack, ok(cameraSummary(camera)));
    });

    socket.on('pair:remove', (raw, ack) => {
      const req = schemas.peer.safeParse(raw);
      if (!req.success) return reply(ack, fail('invalid-request'));
      const peer = req.data.peerId;
      if (!db.unpair(me, peer)) return reply(ack, fail('not-found'));
      endSessionsWhere(
        s => (s.cameraId === me && s.viewerId === peer) || (s.cameraId === peer && s.viewerId === me),
        'unpaired',
      );
      nsp.to(room(peer)).emit('pair:removed', { peerId: me });
      reply(ack, ok(null));
    });

    socket.on('cameras:list', ack => {
      reply(ack, ok(db.camerasForViewer(me).map(cameraSummary)));
    });

    socket.on('viewers:list', ack => {
      reply(ack, ok(db.viewersForCamera(me).map(viewerSummary)));
    });

    socket.on('camera:status', raw => {
      if (!is('camera')) return;
      const status = schemas.status.safeParse(raw);
      if (!status.success) return;
      statuses.set(me, status.data);
      notifyViewers(me);
    });

    // ---- sessions ----

    socket.on('watch:start', (raw, ack) => {
      if (!is('viewer')) return reply(ack, fail('forbidden'));
      const req = schemas.watchStart.safeParse(raw);
      if (!req.success) return reply(ack, fail('invalid-request'));
      const { cameraId } = req.data;

      if (!db.isPaired(cameraId, me)) return reply(ack, fail('not-paired'));
      if (!presence.has(cameraId)) return reply(ack, fail('camera-offline'));
      const active = [...sessions.values()].filter(s => s.cameraId === cameraId);
      if (active.length >= cfg.maxViewersPerCamera) return reply(ack, fail('camera-busy'));

      const session: Session = { id: randomUUID(), cameraId, viewerId: me };
      sessions.set(session.id, session);
      nsp
        .to(room(cameraId))
        .emit('watch:request', { sessionId: session.id, viewer: { id: me, name: socket.data.name } });
      reply(ack, ok({ sessionId: session.id }));
    });

    socket.on('watch:stop', raw => {
      const req = schemas.watchStop.safeParse(raw);
      const session = req.success ? sessions.get(req.data.sessionId) : undefined;
      if (session && (session.cameraId === me || session.viewerId === me)) {
        endSession(session, 'stopped');
      }
    });

    socket.on('signal', raw => {
      const msg = schemas.signal.safeParse(raw);
      if (!msg.success) return;
      const session = sessions.get(msg.data.sessionId);
      if (!session) return;
      const to =
        session.cameraId === me ? session.viewerId : session.viewerId === me ? session.cameraId : null;
      if (!to) return;
      nsp.to(room(to)).emit('signal', { sessionId: session.id, from: me, payload: msg.data.payload });
    });

    socket.on('disconnect', () => {
      const left = (presence.get(me) ?? 1) - 1;
      if (left > 0) return void presence.set(me, left);

      presence.delete(me);
      db.touch(me);
      invites.revoke(me);
      endSessionsWhere(s => s.cameraId === me || s.viewerId === me, 'peer-offline');
      if (is('camera')) notifyViewers(me);
    });
  });
}
