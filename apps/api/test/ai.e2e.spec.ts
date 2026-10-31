import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { clientId, registerUser, req, startApp, TestContext, TestUser } from './helpers';

// A stand-in for the AI gateway's Gemini generateContent route: it checks the token and the
// request, and answers like Gemini does.
let gateway: Server;
let seen: { url: string; auth: string | undefined; body: { contents: { parts: Record<string, unknown>[] }[] } }[] = [];
let failNext = false;
let ctx: TestContext;

beforeAll(async () => {
  gateway = createServer(async (r: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of r) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ url: r.url ?? '', auth: r.headers.authorization, body });
    if (failNext) {
      failNext = false;
      res.writeHead(500).end('{"error":"boom"}');
      return;
    }
    const parts = body.contents[0].parts as { text?: string; inline_data?: unknown }[];
    const reply = parts.some((p) => p.inline_data) ? 'मैं पाँच बजे आऊँगा' : `translated: ${/<message>\n([\s\S]*)\n<\/message>/.exec(parts[0].text ?? '')?.[1]}`;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: reply }] } }] }));
  });
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const port = (gateway.address() as AddressInfo).port;
  ctx = await startApp({ AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/`, AI_GATEWAY_TOKEN: 'nt_test_token_123' });
});
afterAll(async () => {
  await ctx.close();
  await new Promise((done) => gateway.close(done));
});

const user = () => registerUser(ctx.app, 'ai');
const call = (method: string, url: string, u: TestUser, body?: unknown) => req(ctx.app, method, url, { token: u.token, body });

async function chat(a: TestUser, b: TestUser) {
  return (await call('POST', '/v1/conversations/direct', a, { userId: b.id })).body.id as string;
}

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 1)]);

describe('translation and voice-to-text', () => {
  it('says what is on and which languages', async () => {
    const r = await call('GET', '/v1/ai/features', await user());
    expect(r.body).toMatchObject({ translate: true, transcribe: true, languages: { hi: 'Hindi', gu: 'Gujarati', pa: 'Punjabi' } });
  });

  it('translates a message for someone in the chat, once per language, and never for outsiders', async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const cid = await chat(a, b);
    const m = (await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'See you at 5' })).body.message;
    seen = [];
    const r = await call('POST', `/v1/messages/${m.id}/translate`, b, { to: 'hi' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ messageId: m.id, to: 'hi', text: 'translated: See you at 5' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/gemini/v1beta/models/gemini-3-flash:generateContent');
    expect(seen[0].auth).toBe('Bearer nt_test_token_123');
    expect(JSON.stringify(seen[0].body)).toContain('Hindi');

    // Asked again (by anyone in the chat): from the cache.
    await call('POST', `/v1/messages/${m.id}/translate`, a, { to: 'hi' });
    expect(seen).toHaveLength(1);
    expect((await call('POST', `/v1/messages/${m.id}/translate`, b, { to: 'gu' })).status).toBe(200);
    expect(seen).toHaveLength(2);

    expect((await call('POST', `/v1/messages/${m.id}/translate`, c, { to: 'hi' })).status).toBe(404);
    expect((await call('POST', `/v1/messages/${m.id}/translate`, b, { to: 'xx' })).status).toBe(400);
    await call('DELETE', `/v1/messages/${m.id}`, a);
    expect((await call('POST', `/v1/messages/${m.id}/translate`, b, { to: 'pa' })).body.error.code).toBe('message_deleted');
  });

  it('turns a voice note into text, sending the audio itself', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await chat(a, b);
    const up = await call('POST', '/v1/media/uploads', a, { byteSize: OGG.length, kind: 'voice', contentType: 'audio/ogg', durationMs: 2000 });
    await fetch(up.body.upload.url, { method: 'PUT', headers: up.body.upload.headers, body: OGG });
    await call('POST', `/v1/media/${up.body.media.id}/complete`, a);
    const m = (await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), kind: 'voice', mediaId: up.body.media.id })).body.message;
    seen = [];
    const r = await call('POST', `/v1/messages/${m.id}/transcribe`, b);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ messageId: m.id, text: 'मैं पाँच बजे आऊँगा' });
    const audio = seen[0].body.contents[0].parts[1].inline_data as { mime_type: string; data: string };
    expect(audio.mime_type).toBe('audio/ogg');
    expect(Buffer.from(audio.data, 'base64').equals(OGG)).toBe(true);

    const text = (await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'hi' })).body.message;
    expect((await call('POST', `/v1/messages/${text.id}/transcribe`, b)).body.error.code).toBe('not_a_voice_note');
  });

  it('explains a gateway failure without caching it', async () => {
    const [a, b] = [await user(), await user()];
    const cid = await chat(a, b);
    const m = (await call('POST', `/v1/conversations/${cid}/messages`, a, { clientId: clientId(), body: 'Namaste' })).body.message;
    failNext = true;
    const r = await call('POST', `/v1/messages/${m.id}/translate`, b, { to: 'en' });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ai_failed');
    expect((await call('POST', `/v1/messages/${m.id}/translate`, b, { to: 'en' })).body.text).toBe('translated: Namaste');
  });
});
