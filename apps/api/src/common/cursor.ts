import { Errors } from './errors';

/** Opaque keyset cursor over (timestamp, id), newest first. */
export function encodeCursor(ts: Date, id: string) {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(c: string): [string, string] {
  const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!ts || !id || Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw Errors.validation([{ path: 'cursor', message: 'Invalid cursor' }]);
  }
  return [ts, id];
}
