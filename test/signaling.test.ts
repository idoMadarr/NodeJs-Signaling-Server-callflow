import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { io as connect, Socket } from 'socket.io-client';
import { createServer } from '../src/app';
import type { AppConfig } from '../src/config';
import type {
  ClientToServerEvents,
  PairingInvite,
  Role,
  ServerToClientEvents,
} from '../src/protocol';
import { PairingInvites } from '../src/services/pairing';
import { iceServersFor } from '../src/services/security';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const cfg: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  stunUrls: ['stun:stun.example.com:3478'],
  turn: { secret: 'test-secret', urls: ['turn:turn.example.com:3478'], ttlSeconds: 3600 },
  pairingTtlMs: 60_000,
  maxViewersPerCamera: 1,
  pairClaimPerMinute: 3,
  registrationsPerHour: 100,
};

let server: ReturnType<typeof createServer>;
let base = '';
const sockets: Client[] = [];

async function register(role: Role, name?: string) {
  const res = await fetch(`${base}/v2/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { deviceId: string; secret: string };
}

function open(auth: { deviceId: string; secret: string }): Promise<Client> {
  const socket: Client = connect(`${base}/v2`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function next<E extends keyof ServerToClientEvents>(socket: Client, event: E, ms = 2000) {
  return new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    (socket as any).once(event, (arg: any) => {
      clearTimeout(timer);
      resolve(arg);
    });
  });
}

/** Resolves true if the event does NOT arrive within ms. */
function silent(socket: Client, event: keyof ServerToClientEvents, ms = 200) {
  return new Promise<boolean>(resolve => {
    const handler = () => resolve(false);
    (socket as any).once(event, handler);
    setTimeout(() => {
      (socket as any).off(event, handler);
      resolve(true);
    }, ms);
  });
}

before(async () => {
  server = createServer(cfg);
  const port = await server.listen(0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  sockets.forEach(s => s.disconnect());
  await server.close();
});

describe('v2 signaling', () => {
  it('rejects bad credentials', async () => {
    const cam = await register('camera');
    await assert.rejects(open({ deviceId: cam.deviceId, secret: 'wrong' }), /unauthorized/);
    await assert.rejects(open({ deviceId: 'nope', secret: cam.secret }), /unauthorized/);
  });

  it('rejects invalid registration', async () => {
    const res = await fetch(`${base}/v2/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(res.status, 400);
  });

  it('pairs, streams signals, reports status and ends on disconnect', async () => {
    const camCreds = await register('camera', 'Living room');
    const viewerCreds = await register('viewer', 'Ido phone');
    const camera = await open(camCreds);
    const viewer = await open(viewerCreds);

    // Roles are enforced.
    assert.deepEqual(await viewer.emitWithAck('pair:create'), { ok: false, error: 'forbidden' });

    // Pair with the typed code.
    const invite = await camera.emitWithAck('pair:create');
    assert.ok(invite.ok);
    const { code } = invite.data as PairingInvite;
    assert.match(code, /^\d{6}$/);

    const claimed = next(camera, 'pair:claimed');
    const claim = await viewer.emitWithAck('pair:claim', { code });
    assert.ok(claim.ok);
    assert.equal(claim.data.id, camCreds.deviceId);
    assert.equal(claim.data.online, true);
    assert.deepEqual(await claimed, { id: viewerCreds.deviceId, name: 'Ido phone' });

    // Invites are one-time.
    assert.deepEqual(await viewer.emitWithAck('pair:claim', { code }), {
      ok: false,
      error: 'invalid-code',
    });

    const list = await viewer.emitWithAck('cameras:list');
    assert.ok(list.ok);
    assert.deepEqual(
      list.data.map(c => c.name),
      ['Living room'],
    );

    // Status is pushed to paired viewers.
    const update = next(viewer, 'camera:update');
    camera.emit('camera:status', { battery: 0.82, charging: true, network: 'wifi' });
    assert.deepEqual((await update).status, { battery: 0.82, charging: true, network: 'wifi' });

    // Start watching; the camera gets the request.
    const request = next(camera, 'watch:request');
    const start = await viewer.emitWithAck('watch:start', { cameraId: camCreds.deviceId });
    assert.ok(start.ok);
    const { sessionId } = start.data;
    assert.equal((await request).sessionId, sessionId);

    // Second viewer is refused when the camera is at capacity (max 1 in this config).
    const viewer2Creds = await register('viewer');
    const viewer2 = await open(viewer2Creds);
    const invite2 = await camera.emitWithAck('pair:create');
    assert.ok(invite2.ok);
    assert.ok((await viewer2.emitWithAck('pair:claim', { token: invite2.data.token })).ok);
    assert.deepEqual(await viewer2.emitWithAck('watch:start', { cameraId: camCreds.deviceId }), {
      ok: false,
      error: 'camera-busy',
    });

    // Signals are relayed both ways, tagged with the sender.
    const offer = next(viewer, 'signal');
    camera.emit('signal', {
      sessionId,
      payload: { kind: 'description', description: { type: 'offer', sdp: 'v=0' } },
    });
    assert.deepEqual(await offer, {
      sessionId,
      from: camCreds.deviceId,
      payload: { kind: 'description', description: { type: 'offer', sdp: 'v=0' } },
    });

    const candidate = next(camera, 'signal');
    viewer.emit('signal', { sessionId, payload: { kind: 'candidate', candidate: null } });
    assert.equal((await candidate).from, viewerCreds.deviceId);

    // A device outside the session can't inject signals.
    const noLeak = silent(viewer, 'signal');
    viewer2.emit('signal', { sessionId, payload: { kind: 'candidate', candidate: null } });
    assert.ok(await noLeak);

    // Camera going offline ends the session and marks it offline.
    const ended = next(viewer, 'watch:ended');
    const offline = next(viewer, 'camera:update');
    camera.disconnect();
    assert.deepEqual(await ended, { sessionId, reason: 'peer-offline' });
    const off = await offline;
    assert.equal(off.online, false);
    assert.equal(off.status?.battery, 0.82, 'last status is kept');

    assert.deepEqual(await viewer.emitWithAck('watch:start', { cameraId: camCreds.deviceId }), {
      ok: false,
      error: 'camera-offline',
    });
  });

  it('unpairing ends sessions and notifies the peer', async () => {
    const camCreds = await register('camera');
    const viewerCreds = await register('viewer');
    const camera = await open(camCreds);
    const viewer = await open(viewerCreds);

    const invite = await camera.emitWithAck('pair:create');
    assert.ok(invite.ok);
    assert.ok((await viewer.emitWithAck('pair:claim', { token: invite.data.token })).ok);
    const start = await viewer.emitWithAck('watch:start', { cameraId: camCreds.deviceId });
    assert.ok(start.ok);

    const removed = next(viewer, 'pair:removed');
    const ended = next(viewer, 'watch:ended');
    assert.deepEqual(await camera.emitWithAck('pair:remove', { peerId: viewerCreds.deviceId }), {
      ok: true,
      data: null,
    });
    assert.deepEqual(await removed, { peerId: camCreds.deviceId });
    assert.equal((await ended).reason, 'unpaired');
    assert.deepEqual(await viewer.emitWithAck('watch:start', { cameraId: camCreds.deviceId }), {
      ok: false,
      error: 'not-paired',
    });
  });

  it('rate-limits pairing code guesses', async () => {
    const viewer = await open(await register('viewer'));
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await viewer.emitWithAck('pair:claim', { code: '000000' }));
    }
    assert.deepEqual(
      results.map(r => (r.ok ? 'ok' : r.error)),
      ['invalid-code', 'invalid-code', 'invalid-code', 'rate-limited'],
    );
  });

  it('serves ICE servers with valid TURN credentials', async () => {
    const creds = await register('viewer');
    const viewer = await open(creds);
    const res = await viewer.emitWithAck('ice:servers');
    assert.ok(res.ok);
    const turn = res.data[1];
    assert.match(turn.username!, new RegExp(`^\\d+:${creds.deviceId}$`));
    const expected = createHmac('sha1', 'test-secret').update(turn.username!).digest('base64');
    assert.equal(turn.credential, expected);
  });
});

describe('units', () => {
  it('pairing invites expire and are replaced', () => {
    let now = 0;
    const invites = new PairingInvites(1000, () => now);
    const first = invites.create('cam');
    const second = invites.create('cam');
    assert.equal(invites.consume({ token: first.token }), null, 'replaced invite is revoked');
    now = 1001;
    assert.equal(invites.consume({ code: second.code }), null, 'expired');
    now = 0;
    const third = invites.create('cam');
    assert.equal(invites.consume({ code: third.code }), 'cam');
  });

  it('omits TURN when not configured', () => {
    const servers = iceServersFor('x', { ...cfg, turn: { ...cfg.turn, secret: '' } });
    assert.deepEqual(servers, [{ urls: cfg.stunUrls }]);
  });
});
