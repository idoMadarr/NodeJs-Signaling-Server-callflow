import type { PairingInvite } from '../protocol';
import { newCode, newToken } from './security';

interface Invite extends PairingInvite {
  cameraId: string;
}

/** Short-lived, one-time pairing invites. In memory: a restart just invalidates open invites. */
export class PairingInvites {
  private byToken = new Map<string, Invite>();
  private tokenByCode = new Map<string, string>();
  private tokenByCamera = new Map<string, string>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(cameraId: string): PairingInvite {
    this.revoke(cameraId);
    this.sweep();

    let code = newCode();
    while (this.tokenByCode.has(code)) code = newCode();

    const invite: Invite = { cameraId, token: newToken(), code, expiresAt: this.now() + this.ttlMs };
    this.byToken.set(invite.token, invite);
    this.tokenByCode.set(code, invite.token);
    this.tokenByCamera.set(cameraId, invite.token);
    return { token: invite.token, code: invite.code, expiresAt: invite.expiresAt };
  }

  /** Consumes the invite. Returns its cameraId, or null if unknown or expired. */
  consume(ref: { token?: string; code?: string }): string | null {
    const token = ref.token ?? (ref.code ? this.tokenByCode.get(ref.code) : undefined);
    const invite = token ? this.byToken.get(token) : undefined;
    if (!invite) return null;
    this.delete(invite);
    return invite.expiresAt > this.now() ? invite.cameraId : null;
  }

  revoke(cameraId: string) {
    const token = this.tokenByCamera.get(cameraId);
    const invite = token ? this.byToken.get(token) : undefined;
    if (invite) this.delete(invite);
  }

  private delete(invite: Invite) {
    this.byToken.delete(invite.token);
    this.tokenByCode.delete(invite.code);
    if (this.tokenByCamera.get(invite.cameraId) === invite.token) {
      this.tokenByCamera.delete(invite.cameraId);
    }
  }

  private sweep() {
    const t = this.now();
    for (const invite of this.byToken.values()) if (invite.expiresAt <= t) this.delete(invite);
  }
}
