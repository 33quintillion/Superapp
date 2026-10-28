import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../lib/client-address.ts';

// The API's per-IP limits (sign-in, sign-up, password reset) only work if a client can't pick its own address.
test('a forged X-Forwarded-For entry is never taken as the client address', () => {
  // No proxy in front: Next.js fills the header from the socket.
  assert.equal(clientAddress('198.51.100.7', 0), '198.51.100.7');
  // One proxy: it appended the real peer after whatever the client sent.
  assert.equal(clientAddress('1.2.3.4, 198.51.100.7', 1), '198.51.100.7');
  // Two proxies: the outer one's entry, not the inner proxy's.
  assert.equal(clientAddress('1.2.3.4, 198.51.100.7, 10.0.0.5', 2), '198.51.100.7');
  assert.equal(clientAddress(null, 1), null);
  assert.equal(clientAddress('198.51.100.7', 3), null);
});
