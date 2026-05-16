import { EventEmitter } from 'events';
import { DatabaseService } from './DatabaseService';

export interface MeshCentralMaterial {
  centralInstanceId: string;
  centralApiUrl: string;
  callbackJwt: string;
  jwtIssuedAt: number;
  jwtExpiresAt: number;
}

export interface MeshCentralRow extends MeshCentralMaterial {
  lastBootstrapAt: number;
  lastUsedAt: number | null;
  lastRejectedAt: number | null;
  lastRejectReason: string | null;
}

export class MeshCentralRegistry extends EventEmitter {
  private static instance: MeshCentralRegistry | null = null;
  private warnedMultiRow = false;

  private constructor() { super(); }

  public static getInstance(): MeshCentralRegistry {
    if (!this.instance) this.instance = new MeshCentralRegistry();
    return this.instance;
  }

  public static resetForTest(): void {
    this.instance = null;
  }

  public upsert(material: MeshCentralMaterial): void {
    const db = DatabaseService.getInstance().getDb();
    const prior = this.getActive();
    db.prepare(`
      INSERT INTO mesh_centrals (
        central_instance_id, central_api_url, callback_jwt,
        jwt_issued_at, jwt_expires_at, last_bootstrap_at,
        last_used_at, last_rejected_at, last_reject_reason
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(central_instance_id) DO UPDATE SET
        central_api_url   = excluded.central_api_url,
        callback_jwt      = excluded.callback_jwt,
        jwt_issued_at     = excluded.jwt_issued_at,
        jwt_expires_at    = excluded.jwt_expires_at,
        last_bootstrap_at = excluded.last_bootstrap_at
    `).run(
      material.centralInstanceId,
      material.centralApiUrl,
      material.callbackJwt,
      material.jwtIssuedAt,
      material.jwtExpiresAt,
      Date.now(),
    );

    const isInstanceChange = prior && prior.centralInstanceId !== material.centralInstanceId;
    if (isInstanceChange) {
      this.emit('central-instance-changed', {
        previousInstanceId: prior!.centralInstanceId,
        newInstanceId: material.centralInstanceId,
      });
    }
    this.emit('central-bootstrap', { centralInstanceId: material.centralInstanceId });
  }

  public getActive(): MeshCentralRow | null {
    const db = DatabaseService.getInstance().getDb();
    const rows = db.prepare(`
      SELECT * FROM mesh_centrals ORDER BY last_bootstrap_at DESC
    `).all() as Array<{
      central_instance_id: string;
      central_api_url: string;
      callback_jwt: string;
      jwt_issued_at: number;
      jwt_expires_at: number;
      last_bootstrap_at: number;
      last_used_at: number | null;
      last_rejected_at: number | null;
      last_reject_reason: string | null;
    }>;
    if (rows.length === 0) return null;
    if (rows.length > 1 && !this.warnedMultiRow) {
      console.warn(`[MeshCentralRegistry] multiple central rows present (${rows.length}), multi-central unsupported in v0.79`);
      this.warnedMultiRow = true;
    }
    const r = rows[0];
    return {
      centralInstanceId: r.central_instance_id,
      centralApiUrl: r.central_api_url,
      callbackJwt: r.callback_jwt,
      jwtIssuedAt: r.jwt_issued_at,
      jwtExpiresAt: r.jwt_expires_at,
      lastBootstrapAt: r.last_bootstrap_at,
      lastUsedAt: r.last_used_at,
      lastRejectedAt: r.last_rejected_at,
      lastRejectReason: r.last_reject_reason,
    };
  }

  public clearForInstance(centralInstanceId: string): void {
    DatabaseService.getInstance().getDb()
      .prepare(`DELETE FROM mesh_centrals WHERE central_instance_id = ?`)
      .run(centralInstanceId);
  }

  public markUsed(centralInstanceId: string): void {
    DatabaseService.getInstance().getDb()
      .prepare(`UPDATE mesh_centrals SET last_used_at = ? WHERE central_instance_id = ?`)
      .run(Date.now(), centralInstanceId);
  }

  public markRejected(centralInstanceId: string, reason: string): void {
    DatabaseService.getInstance().getDb()
      .prepare(`UPDATE mesh_centrals SET last_rejected_at = ?, last_reject_reason = ? WHERE central_instance_id = ?`)
      .run(Date.now(), reason, centralInstanceId);
  }
}
