import { can, canManageRole, PERMISSIONS, permissionsOf } from '../src/business/roles';
import { SecretBox } from '../src/crypto/secret-box';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../src/crypto/totp';
import { hashToken, randomToken } from '../src/crypto/tokens';
import { loadConfig } from '../src/config/config';
import { matchesSignature } from '../src/media/media-types';
import { parseForm } from '../src/dev/stripe-sandbox';
import { paymentStatus } from '../src/payments/payments.service';
import { formEncode, ProviderError, SignatureError, signStripePayload, verifyStripeSignature } from '../src/payments/stripe';
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

describe('business staff roles', () => {
  it('gives each role exactly the permissions in the matrix', () => {
    expect(permissionsOf('owner')).toEqual(Object.keys(PERMISSIONS));
    expect(permissionsOf('manager').sort()).toEqual(
      [
        'bookings.manage', 'bookings.view', 'business.edit', 'business.view', 'catalogue.manage', 'orders.manage', 'orders.refund', 'orders.view',
        'payments.view', 'services.manage', 'staff.manage', 'staff.view',
      ].sort(),
    );
    expect(permissionsOf('staff').sort()).toEqual(['bookings.manage', 'bookings.view', 'business.view', 'orders.manage', 'orders.view', 'staff.view'].sort());
    expect(can(null, 'business.view')).toBe(false);
    // Where the money goes and what the business pays for stay with the owner.
    expect(can('manager', 'payments.manage')).toBe(false);
    expect(can('manager', 'billing.manage')).toBe(false);
    expect(can('staff', 'orders.refund')).toBe(false);
  });

  it('lets people manage only roles below their own', () => {
    expect(canManageRole('owner', 'manager')).toBe(true);
    expect(canManageRole('owner', 'staff')).toBe(true);
    expect(canManageRole('owner', 'owner')).toBe(false);
    expect(canManageRole('manager', 'staff')).toBe(true);
    expect(canManageRole('manager', 'manager')).toBe(false);
    expect(canManageRole('manager', 'owner')).toBe(false);
    expect(canManageRole('staff', 'staff')).toBe(false);
  });
});

describe('Stripe webhook signatures', () => {
  const secret = 'whsec_unit';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', created: 1, livemode: false, data: { object: { id: 'cs_1' } } });
  const now = Date.UTC(2026, 9, 27, 12, 0, 0);
  // Stripe signs "<timestamp>.<body>" with HMAC-SHA256; this is the value its libraries produce.
  const header = signStripePayload(body, secret, now);

  it('accepts a correct signature and returns the event', () => {
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyStripeSignature(Buffer.from(body), header, [secret], 300, now).id).toBe('evt_1');
    // Any of several v1 signatures may match (Stripe sends one per active secret), and any configured secret may sign.
    const both = `${header},v1=${'0'.repeat(64)}`;
    expect(verifyStripeSignature(Buffer.from(body), both, ['whsec_other', secret], 300, now).type).toBe('checkout.session.completed');
  });

  it.each([
    ['no header', undefined],
    ['no timestamp', header.replace(/^t=\d+,/, '')],
    ['no v1 signature', header.replace(/,v1=.*/, ',v0=abc')],
    ['a signature that is not hex', header.replace(/v1=.*/, 'v1=xyz')],
    ['a signature over another body', signStripePayload(body + ' ', secret, now)],
    ['another secret', signStripePayload(body, 'whsec_wrong', now)],
  ])('refuses %s', (_, h) => {
    expect(() => verifyStripeSignature(Buffer.from(body), h, [secret], 300, now)).toThrow(SignatureError);
  });

  it('refuses a replay outside the tolerance, in either direction', () => {
    expect(() => verifyStripeSignature(Buffer.from(body), header, [secret], 300, now + 301_000)).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(Buffer.from(body), header, [secret], 300, now - 301_000)).toThrow(/tolerance/);
    expect(verifyStripeSignature(Buffer.from(body), header, [secret], 300, now + 299_000).id).toBe('evt_1');
  });

  it('refuses signed bodies that are not events', () => {
    const notEvent = JSON.stringify({ hello: 'world' });
    expect(() => verifyStripeSignature(Buffer.from(notEvent), signStripePayload(notEvent, secret, now), [secret], 300, now)).toThrow(/not an event/);
  });
});

describe('Stripe form encoding', () => {
  it('encodes nested objects and arrays in bracket notation, and the sandbox reads them back', () => {
    const params = {
      mode: 'payment',
      line_items: [{ quantity: 2, price_data: { currency: 'gbp', unit_amount: 450, product_data: { name: 'Bread & jam' } } }],
      payment_intent_data: { application_fee_amount: undefined, transfer_data: { destination: 'acct_1' }, metadata: { order_id: 'o1' } },
      reverse_transfer: true,
      skipped: null,
    };
    const encoded = formEncode(params);
    expect(decodeURIComponent(encoded)).toBe(
      'mode=payment&line_items[0][quantity]=2&line_items[0][price_data][currency]=gbp&line_items[0][price_data][unit_amount]=450&line_items[0][price_data][product_data][name]=Bread & jam&payment_intent_data[transfer_data][destination]=acct_1&payment_intent_data[metadata][order_id]=o1&reverse_transfer=true',
    );
    expect(parseForm(encoded)).toEqual({
      mode: 'payment',
      line_items: [{ quantity: '2', price_data: { currency: 'gbp', unit_amount: '450', product_data: { name: 'Bread & jam' } } }],
      payment_intent_data: { transfer_data: { destination: 'acct_1' }, metadata: { order_id: 'o1' } },
      reverse_transfer: 'true',
    });
  });

  it('retries only what may work later', () => {
    expect(new ProviderError('x', 0).retryable).toBe(true);
    expect(new ProviderError('x', 503).retryable).toBe(true);
    expect(new ProviderError('x', 429).retryable).toBe(true);
    expect(new ProviderError('x', 409).retryable).toBe(true);
    expect(new ProviderError('x', 400).retryable).toBe(false);
    expect(new ProviderError('x', 402).retryable).toBe(false);
  });

  it('names payment states for clients', () => {
    expect(paymentStatus('requires_payment', 100, 0)).toBe('unpaid');
    expect(paymentStatus('cancelled', 100, 0)).toBe('cancelled');
    expect(paymentStatus('succeeded', 100, 0)).toBe('paid');
    expect(paymentStatus('succeeded', 100, 40)).toBe('partially_refunded');
    expect(paymentStatus('succeeded', 100, 100)).toBe('refunded');
  });
});

describe('payments configuration', () => {
  const stripe = { PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
  const cfg = (extra: Record<string, string>) => loadConfig({ ...TEST_ENV, ...extra } as NodeJS.ProcessEnv);
  const deployed = { NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://mail', STUN_URLS: 'stun:stun.example.test:3478', S3_AUTO_CREATE_BUCKET: 'false' };

  it('is off unless chosen, and needs both secrets when on', () => {
    expect(cfg({}).PAYMENTS_PROVIDER).toBe('none');
    expect(cfg(stripe).STRIPE_WEBHOOK_SECRET).toEqual(['whsec_x']);
    expect(cfg({ ...stripe, STRIPE_WEBHOOK_SECRET: 'whsec_a, whsec_b' }).STRIPE_WEBHOOK_SECRET).toEqual(['whsec_a', 'whsec_b']);
    expect(() => cfg({ ...stripe, STRIPE_WEBHOOK_SECRET: '' })).toThrow(/needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET/);
    expect(() => cfg({ ...stripe, STRIPE_SECRET_KEY: 'pk_test_x' })).toThrow(/secret or restricted key/);
    expect(() => cfg({ ...stripe, STRIPE_WEBHOOK_SECRET: 'secret' })).toThrow(/whsec_/);
  });

  it('keeps test and live money apart', () => {
    expect(() => cfg({ ...stripe, STRIPE_SECRET_KEY: 'sk_live_x' })).toThrow(/only be used in production/);
    expect(() => cfg({ ...stripe, ...deployed })).toThrow(/Production needs a live Stripe key/);
    expect(cfg({ ...stripe, ...deployed, STRIPE_SECRET_KEY: 'rk_live_x' }).STRIPE_SECRET_KEY).toBe('rk_live_x');
    expect(() => cfg({ ...stripe, ...deployed, STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_API_BASE: 'http://127.0.0.1:1' })).toThrow(/STRIPE_API_BASE is for tests only/);
    // Staging uses test keys.
    expect(cfg({ ...stripe, ...deployed, NODE_ENV: 'staging' }).STRIPE_SECRET_KEY).toBe('sk_test_x');
  });
});
