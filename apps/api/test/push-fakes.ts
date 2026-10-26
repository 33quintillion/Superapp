/**
 * Local stand-ins for the push services, speaking the real wire protocols: HTTP/2 for
 * APNs, OAuth + HTTP v1 for FCM, and encrypted Web Push. They verify what a real service
 * verifies (signatures on our tokens, encryption a browser can open), so the providers
 * are exercised end to end without Apple or Google accounts.
 */
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, KeyObject, randomBytes } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';

export interface Recorded {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** The status the fake answered with. */
  status?: number;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** Replies are taken from the queue in order; when it's empty, `fallback` is used. */
class ReplyQueue {
  readonly queue: Reply[] = [];
  constructor(public fallback: Reply) {}
  next(): Reply {
    return this.queue.shift() ?? this.fallback;
  }
}

// ---------------------------------------------------------------- Web Push

export interface BrowserSubscription {
  p256dh: string;
  auth: string;
  ecdh: ReturnType<typeof createECDH>;
  authSecret: Buffer;
}

/** What a browser creates when it subscribes: a P-256 key pair and a 16-byte auth secret. */
export function browserSubscription(): BrowserSubscription {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url'), ecdh, authSecret };
}

/** Decrypts an aes128gcm Web Push body the way a browser does (RFC 8291 / RFC 8188). */
export function decryptWebPush(body: Buffer, sub: BrowserSubscription): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  if (record.length > rs) throw new Error('expected a single record');
  const shared = sub.ecdh.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, sub.authSecret, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 0x02) throw new Error('missing last-record delimiter');
  return padded.subarray(0, end);
}

/** Checks a VAPID Authorization header the way a push service does. Returns the JWT claims. */
export async function verifyVapid(header: string | undefined, vapidPublicKey: string, endpoint: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header ?? '');
  if (!m) throw new Error(`bad VAPID header: ${header}`);
  if (m[2] !== vapidPublicKey) throw new Error('VAPID key mismatch');
  const pub = Buffer.from(vapidPublicKey, 'base64url');
  const key = await importJWK({ kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, 'ES256');
  const { payload } = await jwtVerify(m[1]!, key, { audience: new URL(endpoint).origin });
  return payload;
}

export async function startWebPushService() {
  const requests: Recorded[] = [];
  const replies = new ReplyQueue({ status: 201 });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r = replies.next();
      requests.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks), status: r.status });
      res.writeHead(r.status, r.headers ?? {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  return {
    requests,
    replies,
    /** A fresh endpoint URL, as a browser would get from its push service. */
    endpoint: () => `${base}/push/${(n += 1)}-${randomBytes(6).toString('hex')}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------- APNs

/** An APNs signing key (.p8 contents) and its public half for verification. */
export function apnsKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
}

/** Cleartext HTTP/2 server that answers like api.push.apple.com and checks our JWT. */
export async function startFakeApns(opts: { publicKey: KeyObject; teamId: string; keyId: string }) {
  const requests: (Recorded & { jwtIssuedAt: number })[] = [];
  const replies = new ReplyQueue({ status: 200 });
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', async () => {
      const auth = String(headers.authorization ?? '').replace(/^bearer /, '');
      let iat = 0;
      try {
        if (decodeProtectedHeader(auth).kid !== opts.keyId) throw new Error('kid');
        const { payload } = await jwtVerify(auth, opts.publicKey, { issuer: opts.teamId, algorithms: ['ES256'] });
        iat = payload.iat ?? 0;
      } catch {
        stream.respond({ ':status': 403, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ reason: 'InvalidProviderToken' }));
        return;
      }
      requests.push({ path: String(headers[':path']), headers: { ...headers } as Recorded['headers'], body: Buffer.concat(chunks), jwtIssuedAt: iat });
      const r = replies.next();
      stream.respond({ ':status': r.status, ...(r.headers ?? {}) });
      stream.end(r.body === undefined ? undefined : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    replies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------- FCM

export function fcmServiceAccount(tokenUri: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    json: JSON.stringify({
      type: 'service_account',
      project_id: 'nexa-test',
      client_email: 'push@nexa-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      token_uri: tokenUri,
    }),
    publicKey,
  };
}

/** Google's OAuth token endpoint and the FCM v1 send endpoint, on one local server. */
export async function startFakeFcm() {
  const requests: Recorded[] = [];
  const replies = new ReplyQueue({ status: 200, body: { name: 'projects/nexa-test/messages/1' } });
  const tokensIssued: string[] = [];
  let publicKey: KeyObject | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/token') {
        const form = new URLSearchParams(body.toString());
        try {
          if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') throw new Error('grant');
          const { payload } = await jwtVerify(form.get('assertion') ?? '', publicKey!, { audience: `${url}/token`, algorithms: ['RS256'] });
          if (payload.scope !== 'https://www.googleapis.com/auth/firebase.messaging') throw new Error('scope');
        } catch {
          return json(400, { error: 'invalid_grant' });
        }
        const token = `ya29.${randomBytes(8).toString('hex')}`;
        tokensIssued.push(token);
        return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      }
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!tokensIssued.includes(bearer)) return json(401, { error: { status: 'UNAUTHENTICATED' } });
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const r = replies.next();
      json(r.status, r.body ?? {}, r.headers);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    replies,
    tokensIssued,
    trust: (key: KeyObject) => (publicKey = key),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function fcmError(status: number, code: string, errorCode?: string) {
  return {
    status,
    body: {
      error: {
        code: status,
        status: code,
        details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [],
      },
    },
  };
}
