import { SecretBox } from '../src/crypto/secret-box';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../src/crypto/totp';
import { hashToken, randomToken } from '../src/crypto/tokens';
import { loadConfig } from '../src/config/config';
import { matchesSignature } from '../src/media/media-types';
import { TEST_ENV } from './helpers';

describe('TOTP (RFC 6238 Appendix B vectors, SHA-1)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  // RFC vectors are 8 digits; we check the 8-digit HOTP and the 6-digit suffix we actually use.
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  it.each(vectors)('t=%i', (t, expected) => {
    expect(hotp(Buffer.from('12345678901234567890'), Math.floor(t / 30), 8)).toBe(expected);
    expect(totp(secret, t * 1000)).toBe(expected.slice(2));
  });

  it('accepts one step of drift and rejects more', () => {
    const t = 1_700_000_000_000;
    const code = totp(secret, t);
    expect(verifyTotp(secret, code, t + 30_000)).not.toBeNull();
    expect(verifyTotp(secret, code, t + 90_000)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', t)).toBeNull();
  });

  it('round-trips base32', () => {
    const b = Buffer.from('any random bytes!');
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));
  it('round-trips and binds to AAD', () => {
    const sealed = box.seal('seed', 'user-1');
    expect(sealed).not.toContain('seed');
    expect(box.open(sealed, 'user-1')).toBe('seed');
    expect(() => box.open(sealed, 'user-2')).toThrow();
  });
  it('detects tampering', () => {
    const parts = box.seal('seed').split('.');
    parts[3] = Buffer.from('xxxx').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
  });
});

describe('tokens', () => {
  it('are random and hashed deterministically', () => {
    const a = randomToken();
    expect(a).not.toBe(randomToken());
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toContain(a);
  });
});

describe('config', () => {
  it('rejects a weak JWT secret', () => {
    expect(() => loadConfig({ ...TEST_ENV, JWT_ACCESS_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_ACCESS_SECRET/);
  });
  it('refuses the in-memory mail transport outside tests', () => {
    expect(() => loadConfig({ ...TEST_ENV, NODE_ENV: 'production', SMTP_URL: undefined } as unknown as NodeJS.ProcessEnv)).toThrow(/memory/);
  });
  it('refuses disabling rate limits in production', () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://x', RATE_LIMIT_DISABLED: 'true' } as NodeJS.ProcessEnv),
    ).toThrow(/RATE_LIMIT_DISABLED/);
  });
  it('rejects a wrong-sized encryption key', () => {
    expect(() => loadConfig({ ...TEST_ENV, DATA_ENCRYPTION_KEY: 'abcd' } as NodeJS.ProcessEnv)).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});

describe('media signatures', () => {
  const hex = (h: string) => Buffer.from(h.replace(/\s/g, ''), 'hex');
  it.each([
    ['image/jpeg', hex('ffd8ffe000104a464946')],
    ['image/png', hex('89504e470d0a1a0a0000000d')],
    ['image/gif', Buffer.from('GIF89a......')],
    ['image/webp', Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')],
    ['video/mp4', Buffer.from('\x00\x00\x00\x18ftypisom', 'latin1')],
    ['video/quicktime', Buffer.from('\x00\x00\x00\x14ftypqt  ', 'latin1')],
    ['audio/ogg', Buffer.from('OggS\x00\x02', 'latin1')],
    ['audio/webm', hex('1a45dfa3a3428680')],
    ['audio/mpeg', Buffer.from('ID3\x04\x00', 'latin1')],
    ['audio/wav', Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1')],
    ['application/pdf', Buffer.from('%PDF-1.7')],
    ['application/zip', hex('504b0304')],
    ['text/plain', Buffer.from('hello')],
  ])('accepts %s', (type, head) => {
    expect(matchesSignature(type, head)).toBe(true);
  });

  it('rejects mismatches, binary text, unknown types and empty files', () => {
    expect(matchesSignature('image/png', hex('ffd8ffe0'))).toBe(false);
    expect(matchesSignature('image/jpeg', Buffer.from('MZ\x90\x00', 'latin1'))).toBe(false);
    expect(matchesSignature('video/mp4', Buffer.from('\x00\x00\x00\x14ftypqt  ', 'latin1'))).toBe(false);
    expect(matchesSignature('text/plain', Buffer.from('a\x00b', 'latin1'))).toBe(false);
    expect(matchesSignature('text/html', Buffer.from('<html>'))).toBe(false);
    expect(matchesSignature('image/png', Buffer.alloc(0))).toBe(false);
  });
});

describe('storage config', () => {
  it('refuses auto-creating buckets in production', () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://x' } as NodeJS.ProcessEnv),
    ).toThrow(/S3_AUTO_CREATE_BUCKET/);
  });
  it('requires a bucket and credentials', () => {
    expect(() => loadConfig({ ...TEST_ENV, S3_BUCKET: undefined } as unknown as NodeJS.ProcessEnv)).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...TEST_ENV, S3_BUCKET: 'Bad_Name' } as NodeJS.ProcessEnv)).toThrow(/S3_BUCKET/);
  });
});
