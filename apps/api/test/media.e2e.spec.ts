import { clientId, registerUser, req, startApp, TestContext, TestUser } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startApp();
});
afterAll(async () => {
  await ctx.close();
});

const user = () => registerUser(ctx.app, 'md');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

// Smallest valid PNG (1x1), plus a few bytes of other formats' signatures.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 1)]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

async function upload(u: TestUser, meta: Record<string, unknown>, bytes: Buffer) {
  const created = await call('POST', '/v1/media/uploads', u, { byteSize: bytes.length, ...meta });
  if (created.status !== 201) throw new Error(`create upload failed: ${JSON.stringify(created.body)}`);
  const put = await fetch(created.body.upload.url, { method: 'PUT', headers: created.body.upload.headers, body: bytes });
  expect(put.status).toBe(200);
  return created.body.media.id as string;
}

async function uploadReady(u: TestUser, meta: Record<string, unknown>, bytes: Buffer) {
  const id = await upload(u, meta, bytes);
  const done = await call('POST', `/v1/media/${id}/complete`, u);
  expect(done.status).toBe(200);
  expect(done.body.state).toBe('ready');
  return id;
}

async function direct(a: TestUser, b: TestUser) {
  return (await call('POST', '/v1/conversations/direct', a, { userId: b.id })).body.id as string;
}

describe('media uploads', () => {
  it('uploads straight to storage, then shares it only with chat members', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const cid = await direct(a, b);
    const mediaId = await uploadReady(a, { kind: 'image', contentType: 'image/png', fileName: 'dot.png', width: 1, height: 1 }, PNG);
    const sent = await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), kind: 'image', mediaId, body: 'a dot' });
    expect(sent.status).toBe(201);
    expect(sent.body.message.media).toMatchObject({ id: mediaId, kind: 'image', contentType: 'image/png', byteSize: PNG.length, width: 1 });

    const dl = await call('GET', `/v1/media/${mediaId}`, b);
    expect(dl.status).toBe(200);
    const got = await fetch(dl.body.url);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect((await call('GET', `/v1/media/${mediaId}`, c)).status).toBe(404);
    // Someone else can't attach a's upload to their own message.
    const cb = await direct(c, b);
    const steal = await call('POST', `/v1/conversations/${cb}/messages`, c, { clientId: clientId(), kind: 'image', mediaId });
    expect(steal.status).toBe(404);
  });

  it('sends a voice note with its duration', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const mediaId = await uploadReady(a, { kind: 'voice', contentType: 'audio/ogg', durationMs: 4200 }, OGG);
    const sent = await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), kind: 'voice', mediaId });
    expect(sent.body.message).toMatchObject({ kind: 'voice', media: { durationMs: 4200, contentType: 'audio/ogg' } });
    // The message kind must match the media kind.
    const other = await uploadReady(a, { kind: 'voice', contentType: 'audio/ogg', durationMs: 1000 }, OGG);
    expect((await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), kind: 'image', mediaId: other })).status).toBe(400);
  });

  it('serves documents as downloads with their file name', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const mediaId = await uploadReady(a, { kind: 'file', contentType: 'application/pdf', fileName: 'Résumé 2026.pdf' }, PDF);
    await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), kind: 'file', mediaId });
    const dl = await call('GET', `/v1/media/${mediaId}`, b);
    const got = await fetch(dl.body.url);
    expect(got.headers.get('content-disposition')).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%202026.pdf");
  });

  it('refuses disallowed types, oversized files and voice notes without a duration', async () => {
    const a = await user();
    const bad = [
      { kind: 'image', contentType: 'image/svg+xml', byteSize: 10 },
      { kind: 'file', contentType: 'text/html', byteSize: 10 },
      { kind: 'file', contentType: 'application/x-msdownload', byteSize: 10 },
      { kind: 'image', contentType: 'image/png', byteSize: 21 * 1024 * 1024 },
      { kind: 'voice', contentType: 'audio/ogg', byteSize: 10 },
      { kind: 'voice', contentType: 'audio/ogg', byteSize: 10, durationMs: 16 * 60 * 1000 },
      { kind: 'image', contentType: 'image/png', byteSize: 0 },
    ];
    for (const body of bad) expect([body, (await call('POST', '/v1/media/uploads', a, body)).status]).toEqual([body, 400]);
  });

  it('rejects an upload whose bytes do not match its declared type, and deletes it', async () => {
    const a = await user();
    const fake = Buffer.from('MZ\x90\x00 this is not really a png file....', 'latin1');
    const id = await upload(a, { kind: 'image', contentType: 'image/png' }, fake);
    const done = await call('POST', `/v1/media/${id}/complete`, a);
    expect(done.status).toBe(400);
    expect(done.body.error.code).toBe('media_rejected');
    expect((await call('GET', `/v1/media/${id}`, a)).status).toBe(404);
    expect((await call('POST', `/v1/media/${id}/complete`, a)).status).toBe(400);
  });

  it('will not complete before the upload exists, or send media that is not complete', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await direct(a, b);
    const created = await call('POST', '/v1/media/uploads', a, { kind: 'image', contentType: 'image/png', byteSize: PNG.length });
    const id = created.body.media.id;
    const early = await call('POST', `/v1/media/${id}/complete`, a);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('upload_missing');
    const send = await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), kind: 'image', mediaId: id });
    expect(send.body.error.code).toBe('media_not_ready');
    // Only the uploader can complete it.
    expect((await call('POST', `/v1/media/${id}/complete`, b)).status).toBe(404);
  });

  it('deletes the stored file when its only message is deleted, but keeps it for forwarded copies', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const ab = await direct(a, b);
    const bc = await direct(b, c);
    const solo = await uploadReady(a, { kind: 'image', contentType: 'image/png' }, PNG);
    const m1 = (await call('POST', `/v1/conversations/${ab}/messages`, a, { clientId: clientId(), kind: 'image', mediaId: solo })).body.message;
    const url = (await call('GET', `/v1/media/${solo}`, b)).body.url;
    await call('DELETE', `/v1/messages/${m1.id}`, a);
    expect((await call('GET', `/v1/media/${solo}`, b)).status).toBe(404);
    expect((await call('GET', `/v1/media/${solo}`, a)).status).toBe(404);
    // The object itself is gone (S3 answers 403 or 404 depending on bucket permissions).
    expect((await fetch(url)).ok).toBe(false);

    const shared = await uploadReady(a, { kind: 'image', contentType: 'image/png' }, PNG);
    const m2 = (await call('POST', `/v1/conversations/${ab}/messages`, a, { clientId: clientId(), kind: 'image', mediaId: shared })).body.message;
    const fwd = await call('POST', `/v1/messages/${m2.id}/forward`, b, { conversationIds: [bc], clientId: clientId() });
    expect(fwd.body.messages[0].media.id).toBe(shared);
    await call('DELETE', `/v1/messages/${m2.id}`, a);
    // The forwarded copy still references the file, so it is kept for c.
    expect((await call('GET', `/v1/media/${shared}`, c)).status).toBe(200);
  });
});
