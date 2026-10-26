import { authed } from '@/lib/session';
import type { Conversation } from '@/lib/chat-client';
import { ChatApp } from './chat-app';

export const dynamic = 'force-dynamic';

export default async function ChatsPage() {
  const [me, list] = await Promise.all([
    authed<{ id: string; displayName: string }>('GET', '/v1/me'),
    authed<{ conversations: Conversation[] }>('GET', '/v1/conversations'),
  ]);
  // The WebSocket goes to the API directly (Next.js cannot proxy it); only a 60-second,
  // single-use ticket ever reaches the browser.
  const wsBase = process.env.API_PUBLIC_WS_URL ?? 'ws://localhost:3000';
  return <ChatApp me={me} initial={list.conversations} wsBase={wsBase} />;
}
