import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { Role } from './protocol';

export interface DeviceRow {
  id: string;
  secret_hash: string;
  role: Role;
  name: string;
  created_at: number;
  last_seen: number | null;
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('camera', 'viewer')),
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER
  );

  CREATE TABLE IF NOT EXISTS pairings (
    camera_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    viewer_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (camera_id, viewer_id)
  );

  CREATE INDEX IF NOT EXISTS pairings_by_viewer ON pairings(viewer_id);
`;

export type Db = ReturnType<typeof openDb>;

export function openDb(file: string) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const q = {
    insertDevice: db.prepare(
      'INSERT INTO devices (id, secret_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    getDevice: db.prepare('SELECT * FROM devices WHERE id = ?'),
    updateDevice: db.prepare('UPDATE devices SET name = ?, role = ? WHERE id = ?'),
    touch: db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?'),
    insertPairing: db.prepare(
      'INSERT OR IGNORE INTO pairings (camera_id, viewer_id, created_at) VALUES (?, ?, ?)',
    ),
    deletePairing: db.prepare(
      `DELETE FROM pairings
       WHERE (camera_id = ? AND viewer_id = ?) OR (camera_id = ? AND viewer_id = ?)`,
    ),
    isPaired: db.prepare('SELECT 1 AS ok FROM pairings WHERE camera_id = ? AND viewer_id = ?'),
    camerasForViewer: db.prepare(
      `SELECT d.* FROM pairings p JOIN devices d ON d.id = p.camera_id
       WHERE p.viewer_id = ? ORDER BY p.created_at`,
    ),
    viewersForCamera: db.prepare(
      `SELECT d.* FROM pairings p JOIN devices d ON d.id = p.viewer_id
       WHERE p.camera_id = ? ORDER BY p.created_at`,
    ),
  };

  const asDevice = (row: unknown) => (row ? ({ ...(row as object) } as DeviceRow) : null);
  const asDevices = (rows: unknown[]) => rows.map(r => asDevice(r)!);

  return {
    insertDevice(d: { id: string; secretHash: string; role: Role; name: string }) {
      q.insertDevice.run(d.id, d.secretHash, d.role, d.name, Date.now());
    },
    getDevice: (id: string) => asDevice(q.getDevice.get(id)),
    updateDevice(id: string, name: string, role: Role) {
      q.updateDevice.run(name, role, id);
    },
    touch(id: string, at = Date.now()) {
      q.touch.run(at, id);
    },
    pair(cameraId: string, viewerId: string) {
      q.insertPairing.run(cameraId, viewerId, Date.now());
    },
    /** Removes the pairing in either direction. Returns true if something was removed. */
    unpair(a: string, b: string) {
      return Number(q.deletePairing.run(a, b, b, a).changes) > 0;
    },
    isPaired: (cameraId: string, viewerId: string) => !!q.isPaired.get(cameraId, viewerId),
    camerasForViewer: (viewerId: string) => asDevices(q.camerasForViewer.all(viewerId)),
    viewersForCamera: (cameraId: string) => asDevices(q.viewersForCamera.all(cameraId)),
    close: () => db.close(),
  };
}
