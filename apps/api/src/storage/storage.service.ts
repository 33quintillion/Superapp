import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG, AppConfig } from '../config/config';

export interface ObjectInfo {
  size: number;
  contentType: string | undefined;
}

/**
 * Thin wrapper over an S3-compatible bucket. The bucket is private: clients only
 * ever get short-lived presigned URLs for a single object, issued after an access check.
 */
@Injectable()
export class StorageService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Storage');
  private readonly internal: S3Client;
  /** Signs URLs with the host clients can reach. Never used to make requests itself. */
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const base = {
      region: config.S3_REGION,
      // Otherwise the SDK signs a checksum of an empty body into presigned PUTs.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    };
    this.internal = new S3Client({ ...base, endpoint: config.S3_ENDPOINT });
    this.signer = new S3Client({ ...base, endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT });
    this.bucket = config.S3_BUCKET;
  }

  async onApplicationBootstrap() {
    if (this.config.S3_AUTO_CREATE_BUCKET) {
      try {
        await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket ${this.bucket}`);
      }
    } else if (!this.config.S3_MANAGE_CORS) {
      return;
    }
    // Browsers upload straight to the bucket, so it has to allow the web origins. Locally the
    // bucket is created here too; when deployed, S3_MANAGE_CORS sets the rule on a provisioned bucket.
    const origins = this.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    if (origins.length === 0) return;
    try {
      await this.internal.send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET'], AllowedHeaders: ['*'], MaxAgeSeconds: 600 }],
          },
        }),
      );
    } catch (err) {
      this.logger.warn(`Could not set CORS on bucket ${this.bucket}: ${(err as Error).name}`);
    }
  }

  async ping() {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /**
   * Content type, length and (if given) disposition are signed, so the client must upload
   * exactly what it declared. The disposition is stored with the object because not every
   * S3-compatible server honours the response override on presigned GETs.
   */
  presignPut(key: string, contentType: string, size: number, expiresIn: number, contentDisposition?: string) {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size, ContentDisposition: contentDisposition }),
      {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length', ...(contentDisposition ? ['content-disposition'] : [])]),
      },
    );
  }

  presignGet(key: string, expiresIn: number, opts: { downloadName?: string; contentType?: string } = {}) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.downloadName ? contentDisposition(opts.downloadName) : undefined,
      }),
      { expiresIn },
    );
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const r = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (err) {
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  /** First bytes of an object, for checking that its content matches its declared type. */
  async readPrefix(key: string, bytes: number): Promise<Buffer> {
    const r = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    const arr = await r.Body!.transformToByteArray();
    return Buffer.from(arr.subarray(0, bytes));
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.internal.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string) {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  onModuleDestroy() {
    this.internal.destroy();
    this.signer.destroy();
  }
}

/** RFC 6266 attachment header with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
