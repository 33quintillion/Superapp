import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guards against regressions that would expose tokens to browser JavaScript.
test('session cookies are httpOnly and same-site', () => {
  const src = readFileSync(new URL('../lib/cookies.ts', import.meta.url), 'utf8');
  assert.match(src, /httpOnly: true/);
  assert.match(src, /sameSite: 'lax'/);
  assert.match(src, /secure = process.env.NODE_ENV === 'production'/);
});

test('API base URL is server-only (not NEXT_PUBLIC_)', () => {
  const src = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');
  assert.match(src, /^import 'server-only';/m);
  assert.doesNotMatch(src, /NEXT_PUBLIC_/);
});
