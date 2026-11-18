/**
 * Wire protocol for the /v2 socket.io namespace.
 * The client keeps a copy of this file (client/src/protocol.ts). Keep the two in sync.
 */

export type Role = 'camera' | 'viewer';

export type ErrorCode =
  | 'invalid-request'
  | 'forbidden'
  | 'not-found'
  | 'not-paired'
  | 'invalid-code'
  | 'camera-offline'
  | 'camera-busy'
  | 'rate-limited';

export type AckResult<T> = { ok: true; data: T } | { ok: false; error: ErrorCode };
export type Ack<T> = (result: AckResult<T>) => void;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CameraStatus {
  /** 0..1 */
  battery?: number;
  charging?: boolean;
  network?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
}

export interface CameraSummary {
  id: string;
  name: string;
  online: boolean;
  /** Last reported status; kept after the camera goes offline. */
  status: CameraStatus | null;
  /** ms epoch */
  lastSeen: number | null;
}

export interface ViewerSummary {
  id: string;
  name: string;
}

export interface PairingInvite {
  /** Encoded into the QR code. */
  token: string;
  /** 6 digits, for typing in by hand. */
  code: string;
  /** ms epoch */
  expiresAt: number;
}

export type SessionDescription = { type: 'offer' | 'answer'; sdp: string };
export type IceCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
};

export type SignalPayload =
  | { kind: 'description'; description: SessionDescription }
  /** `candidate: null` = end of candidates */
  | { kind: 'candidate'; candidate: IceCandidate | null };

export interface OutgoingSignal {
  sessionId: string;
  payload: SignalPayload;
}

export interface IncomingSignal {
  sessionId: string;
  from: string;
  payload: SignalPayload;
}

export type SessionEndReason = 'stopped' | 'peer-offline' | 'unpaired';

export interface ClientToServerEvents {
  /** Any role. Update this device's name and/or role. */
  'device:update': (req: { name?: string; role?: Role }, ack: Ack<null>) => void;
  /** Any role. */
  'ice:servers': (ack: Ack<IceServer[]>) => void;

  /** Camera. Replaces any previous invite of this camera. */
  'pair:create': (ack: Ack<PairingInvite>) => void;
  /** Viewer. Exactly one of token / code. */
  'pair:claim': (req: { token?: string; code?: string }, ack: Ack<CameraSummary>) => void;
  /** Any role. Removes the pairing with peerId. */
  'pair:remove': (req: { peerId: string }, ack: Ack<null>) => void;

  /** Viewer. */
  'cameras:list': (ack: Ack<CameraSummary[]>) => void;
  /** Camera. */
  'viewers:list': (ack: Ack<ViewerSummary[]>) => void;
  /** Camera. Pushed to paired viewers. */
  'camera:status': (status: CameraStatus) => void;

  /** Viewer. The camera gets `watch:request` and should send the offer. */
  'watch:start': (req: { cameraId: string }, ack: Ack<{ sessionId: string }>) => void;
  /** Either side of a session. */
  'watch:stop': (req: { sessionId: string }) => void;
  /** Either side of a session; relayed to the other side. */
  signal: (msg: OutgoingSignal) => void;
}

export interface ServerToClientEvents {
  /** To camera: a viewer claimed its invite. */
  'pair:claimed': (viewer: ViewerSummary) => void;
  /** To either side: the other side removed the pairing. */
  'pair:removed': (req: { peerId: string }) => void;
  /** To viewers: a paired camera changed (online, status, name). */
  'camera:update': (camera: CameraSummary) => void;
  /** To camera: a viewer wants to watch. */
  'watch:request': (req: { sessionId: string; viewer: ViewerSummary }) => void;
  /** To either side. */
  'watch:ended': (req: { sessionId: string; reason: SessionEndReason }) => void;
  signal: (msg: IncomingSignal) => void;
}
