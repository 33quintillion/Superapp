import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, Errors } from '../common/errors';
import { RateLimitService } from '../common/rate-limit.service';
import { DatabaseService, Queryable } from '../database/database.service';
import { contentDisposition, StorageService } from '../storage/storage.service';
import { ALLOWED_TYPES, MAX_BYTES, MAX_VOICE_MS, MediaKind, matchesSignature, SNIFF_BYTES } from './media-types';

export interface MediaRow {
  id: string;
  owner_id: string | null;
  kind: MediaKind;
  content_type: string;
  byte_size: string;
  file_name: string;
  object_key: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  state: 'pending' | 'ready' | 'rejected' | 'deleted';
}

export interface UploadRequest {
  kind: MediaKind;
  contentType: string;
  byteSize: number;
  fileName: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

const UPLOAD_URL_TTL = 15 * 60;
const DOWNLOAD_URL_TTL = 5 * 60;

export function mediaDto(m: MediaRow) {
  return {
    id: m.id,
    kind: m.kind,
    contentType: m.content_type,
    byteSize: Number(m.byte_size),
    fileName: m.file_name,
    durationMs: m.duration_ms,
    width: m.width,
    height: m.height,
    state: m.state,
  };
}

const rejected = (message: string) => new AppError(HttpStatus.BAD_REQUEST, 'media_rejected', message);

@Injectable()
export class MediaService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly limits: RateLimitService,
  ) {}

  /** Step 1: reserve a media id and hand back a presigned PUT for exactly the declared bytes. */
  async createUpload(userId: string, r: UploadRequest) {
    await this.limits.consume({ name: 'media:upload', limit: 200, windowSeconds: 3600 }, userId);
    if (!ALLOWED_TYPES[r.kind].includes(r.contentType)) {
      throw Errors.validation([{ path: 'contentType', message: `${r.contentType} is not allowed for ${r.kind}` }]);
    }
    if (r.byteSize > MAX_BYTES[r.kind]) {
      throw Errors.validation([{ path: 'byteSize', message: `Files of this kind can be at most ${MAX_BYTES[r.kind]} bytes` }]);
    }
    if (r.kind === 'voice' && (!r.durationMs || r.durationMs > MAX_VOICE_MS)) {
      throw Errors.validation([{ path: 'durationMs', message: `Voice notes need a duration of at most ${MAX_VOICE_MS} ms` }]);
    }
    const m = await this.db.one<MediaRow>(
      `INSERT INTO media (owner_id, kind, content_type, byte_size, file_name, object_key, duration_ms, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      // The key never contains anything the client chose.
      [userId, r.kind, r.contentType, r.byteSize, r.fileName, `media/${userId}/${randomUUID()}`, r.durationMs ?? null, r.width ?? null, r.height ?? null],
    );
    // Documents are always downloaded, never rendered by the browser.
    const disposition = r.kind === 'file' ? contentDisposition(r.fileName || 'file') : undefined;
    const url = await this.storage.presignPut(m!.object_key, r.contentType, r.byteSize, UPLOAD_URL_TTL, disposition);
    return {
      media: mediaDto(m!),
      upload: {
        method: 'PUT',
        url,
        headers: { 'content-type': r.contentType, ...(disposition ? { 'content-disposition': disposition } : {}) },
        expiresIn: UPLOAD_URL_TTL,
      },
    };
  }

  /**
   * Step 2: after the client uploaded, check the stored object really is what was declared
   * (size and file signature). Anything else is deleted and the media is rejected.
   */
  async complete(userId: string, mediaId: string) {
    const m = await this.db.one<MediaRow>('SELECT * FROM media WHERE id = $1 AND owner_id = $2', [mediaId, userId]);
    if (!m) throw Errors.notFound('Media');
    if (m.state === 'ready') return mediaDto(m);
    if (m.state !== 'pending') throw rejected('This upload was rejected');
    const info = await this.storage.head(m.object_key);
    if (!info) throw Errors.conflict('upload_missing', 'Nothing has been uploaded for this media yet');
    let reason: string | null = null;
    if (info.size !== Number(m.byte_size)) reason = 'Uploaded size does not match the declared size';
    else if (!matchesSignature(m.content_type, await this.storage.readPrefix(m.object_key, SNIFF_BYTES))) {
      reason = 'File contents do not match the declared type';
    }
    if (reason) {
      await this.db.query(`UPDATE media SET state = 'rejected' WHERE id = $1`, [m.id]);
      await this.storage.delete(m.object_key);
      throw rejected(reason);
    }
    const done = await this.db.one<MediaRow>(`UPDATE media SET state = 'ready', completed_at = now() WHERE id = $1 RETURNING *`, [m.id]);
    return mediaDto(done!);
  }

  /** A short-lived download URL, for the owner or a member of a chat where it was shared. */
  async download(userId: string, mediaId: string) {
    const m = await this.db.one<MediaRow>(
      `SELECT m.* FROM media m WHERE m.id = $1 AND m.state = 'ready' AND (
         m.owner_id = $2 OR EXISTS (
           SELECT 1 FROM messages msg JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id
            WHERE msg.media_id = m.id AND msg.deleted_at IS NULL AND cm.user_id = $2))`,
      [mediaId, userId],
    );
    // 404 rather than 403 so ids cannot be probed.
    if (!m) throw Errors.notFound('Media');
    const url = await this.storage.presignGet(m.object_key, DOWNLOAD_URL_TTL, {
      contentType: m.content_type,
      downloadName: m.kind === 'file' ? m.file_name || 'file' : undefined,
    });
    return { media: mediaDto(m), url, expiresIn: DOWNLOAD_URL_TTL };
  }

  /** Media the user may attach to a new message: their own and fully uploaded. */
  async requireAttachable(userId: string, mediaId: string, db?: Queryable): Promise<MediaRow> {
    const m = await this.db.one<MediaRow>(`SELECT * FROM media WHERE id = $1 AND owner_id = $2`, [mediaId, userId], db);
    if (!m) throw Errors.notFound('Media');
    if (m.state !== 'ready') throw Errors.conflict('media_not_ready', 'Finish the upload before sending it');
    return m;
  }

  /** Deletes the stored object once no remaining message uses it. */
  async releaseIfUnused(mediaId: string) {
    const m = await this.db.one<{ object_key: string }>(
      `UPDATE media SET state = 'deleted' WHERE id = $1 AND state IN ('ready', 'pending')
         AND NOT EXISTS (SELECT 1 FROM messages WHERE media_id = $1) RETURNING object_key`,
      [mediaId],
    );
    if (m) await this.storage.delete(m.object_key);
  }
}
