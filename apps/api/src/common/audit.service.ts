import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../database/database.service';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record(e: AuditEntry, client?: Queryable) {
    await this.db.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, ip, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.actorId, e.action, e.targetType ?? null, e.targetId ?? null, e.ip ?? null, JSON.stringify(e.metadata ?? {})],
      client,
    );
  }
}
