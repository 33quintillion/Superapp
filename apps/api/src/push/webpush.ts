import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';

/**
 * Web Push message encryption (RFC 8291, "aes128gcm" content coding from RFC 8188) and
 * VAPID sender identification (RFC 8292). Only browsers holding the subscription's
 * private key can read a payload; the push service relays ciphertext.
 */

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export interface EncryptOptions {
  /** Fixed salt and sender key: only for reproducing the RFC test vector. */
  salt?: Buffer;
  senderPrivateKey?: Buffer;
  recordSize?: number;
}

/** Encrypts one push message for a browser subscription (single record). */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string, opts: EncryptOptions = {}): Buffer {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh must be an uncompressed P-256 public key');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  const recordSize = opts.recordSize ?? 4096;
  // One record: 16 bytes of tag + 1 delimiter byte must fit with the plaintext.
  if (plaintext.length + 17 > recordSize) throw new Error('payload too large for one record');

  const ecdh = createECDH('prime256v1');
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record; no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** A new VAPID key pair, both base64url (65-byte public point, 32-byte private scalar). */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Throws unless the two keys are a valid matching P-256 pair. */
export function checkVapidKeys(keys: VapidKeys) {
  const pub = unb64u(keys.publicKey);
  const priv = unb64u(keys.privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 public key');
  if (priv.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a base64url 32-byte P-256 private key');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(priv);
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY');
}

/** Signs VAPID tokens, one per push service origin, reused for an hour. */
export class VapidSigner {
  private readonly cache = new Map<string, { header: string; until: number }>();
  private key: ReturnType<typeof importJWK> | null = null;

  constructor(
    private readonly keys: VapidKeys,
    private readonly subject: string,
  ) {
    checkVapidKeys(keys);
  }

  async authorization(endpoint: string): Promise<string> {
    const audience = new URL(endpoint).origin;
    const now = Math.floor(Date.now() / 1000);
    const hit = this.cache.get(audience);
    if (hit && hit.until > now) return hit.header;
    const pub = unb64u(this.keys.publicKey);
    this.key ??= importJWK(
      { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: this.keys.privateKey },
      'ES256',
    );
    // RFC 8292 allows up to 24 hours; 12 leaves room for clock skew.
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setAudience(audience)
      .setSubject(this.subject)
      .setExpirationTime(now + 12 * 3600)
      .sign(await this.key);
    const header = `vapid t=${jwt}, k=${this.keys.publicKey}`;
    this.cache.set(audience, { header, until: now + 3600 });
    return header;
  }
}
