import { SecretBox } from '../src/crypto/secret-box';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../src/crypto/totp';
import { hashToken, randomToken } from '../src/crypto/tokens';
import { loadConfig } from '../src/config/config';
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
