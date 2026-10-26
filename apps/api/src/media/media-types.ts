export type MediaKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

const MB = 1024 * 1024;

/** Upper bounds per kind. Kept modest until transcoding and scanning exist. */
export const MAX_BYTES: Record<MediaKind, number> = {
  image: 20 * MB,
  video: 100 * MB,
  audio: 50 * MB,
  voice: 16 * MB,
  file: 100 * MB,
};

/** Voice notes longer than this are rejected. */
export const MAX_VOICE_MS = 15 * 60 * 1000;

const AUDIO = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav'];

/** Allowed content types per kind. Anything else is refused; executables and HTML never are allowed. */
export const ALLOWED_TYPES: Record<MediaKind, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: AUDIO,
  voice: AUDIO,
  file: [
    'application/pdf',
    'text/plain',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ...['image/jpeg', 'image/png', 'video/mp4', ...AUDIO],
  ],
};

export const SNIFF_BYTES = 32;

const ascii = (b: Buffer, start: number, s: string) => b.subarray(start, start + s.length).toString('latin1') === s;
const isoBmff = (b: Buffer, brands: string[]) => ascii(b, 4, 'ftyp') && brands.some((x) => ascii(b, 8, x));
const ZIP = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => ascii(b, 0, '\x89PNG\r\n\x1a\n'),
  'image/gif': (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  'image/heic': (b) => isoBmff(b, ['heic', 'heix', 'mif1', 'msf1']),
  'video/mp4': (b) => ascii(b, 4, 'ftyp') && !isoBmff(b, ['qt  ']),
  'video/quicktime': (b) => isoBmff(b, ['qt  ']) || ascii(b, 4, 'moov') || ascii(b, 4, 'mdat') || ascii(b, 4, 'wide'),
  'video/webm': (b) => b.readUInt32BE(0) === 0x1a45dfa3,
  'audio/webm': (b) => b.readUInt32BE(0) === 0x1a45dfa3,
  'audio/ogg': (b) => ascii(b, 0, 'OggS'),
  'audio/wav': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  'audio/mpeg': (b) => ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/mp4': (b) => ascii(b, 4, 'ftyp'),
  'audio/aac': (b) => (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) || ascii(b, 4, 'ftyp'),
  'application/pdf': (b) => ascii(b, 0, '%PDF-'),
  'application/zip': ZIP,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ZIP,
};

/**
 * Checks the first bytes of an upload against its declared type, so a file cannot
 * claim to be an image while being something else. Plain text has no signature, so
 * anything containing a NUL byte is refused. This is not a malware scan.
 */
export function matchesSignature(contentType: string, head: Buffer): boolean {
  if (contentType === 'text/plain') return head.length > 0 && !head.includes(0);
  if (head.length < 4) return false;
  const check = SIGNATURES[contentType];
  return !!check && check(Buffer.concat([head, Buffer.alloc(Math.max(0, SNIFF_BYTES - head.length))]));
}
