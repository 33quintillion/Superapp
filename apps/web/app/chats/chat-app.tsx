'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChatApiError,
  chatApi,
  ConnectionState,
  Conversation,
  kindForFile,
  Media,
  Message,
  newClientId,
  RealtimeClient,
  uploadMedia,
} from '@/lib/chat-client';

interface Me {
  id: string;
  displayName: string;
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮'];
const TYPING_TTL = 6000;

function sortMessages(list: Message[]) {
  return [...list].sort((a, b) => (a.pending ? Infinity : a.seq) - (b.pending ? Infinity : b.seq));
}

function sortConversations(list: Conversation[]) {
  const at = (c: Conversation) => Date.parse(c.lastMessageAt ?? '') || 0;
  return [...list].sort((a, b) => at(b) - at(a));
}

function peerOf(c: Conversation | undefined, me: string) {
  return c?.members.find((m) => m.userId !== me);
}

export function ChatApp({ me, initial, wsBase, initialActiveId }: { me: Me; initial: Conversation[]; wsBase: string; initialActiveId?: string }) {
  const [convs, setConvs] = useState<Conversation[]>(initial);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId ?? initial[0]?.id ?? null);
  const [msgs, setMsgs] = useState<Record<string, Message[]>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [conn, setConn] = useState<ConnectionState>('connecting');
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [presence, setPresence] = useState<Record<string, { online: boolean | null; lastSeenAt: string | null }>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  const synced = useRef<Record<string, number>>({});
  const loaded = useRef(new Set<string>());
  const resyncing = useRef(new Set<string>());
  const rt = useRef<RealtimeClient | null>(null);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const upsert = useCallback((cid: string, incoming: Message[], remove: string[] = []) => {
    setMsgs((prev) => {
      let list = (prev[cid] ?? []).filter((m) => !remove.includes(m.id));
      for (const m of incoming) {
        const i = list.findIndex((x) => x.id === m.id || (x.pending && x.clientId === m.clientId && x.senderId === m.senderId));
        if (i === -1) list = [...list, m];
        else if (list[i].pending || list[i].changeSeq <= m.changeSeq) list = list.map((x, j) => (j === i ? m : x));
      }
      return { ...prev, [cid]: sortMessages(list) };
    });
  }, []);

  const refreshConversation = useCallback(async (cid: string) => {
    try {
      const c = await chatApi<Conversation>('GET', `conversations/${cid}`);
      setConvs((prev) => sortConversations([...prev.filter((x) => x.id !== c.id), c]));
    } catch {
      // Shown again on the next event or reconnect.
    }
  }, []);

  /** Pulls every change since the last one applied. Used after reconnects and on gaps. */
  const resync = useCallback(
    async (cid: string) => {
      if (resyncing.current.has(cid)) return;
      resyncing.current.add(cid);
      try {
        for (let guard = 0; guard < 50; guard++) {
          const page = await chatApi<{ changes: (Message | { id: string; hidden: true })[]; nextSince: number; hasMore: boolean }>(
            'GET',
            `conversations/${cid}/changes?since=${synced.current[cid] ?? 0}`,
          );
          const hidden = page.changes.filter((c): c is { id: string; hidden: true } => 'hidden' in c).map((c) => c.id);
          upsert(cid, page.changes.filter((c): c is Message => !('hidden' in c)), hidden);
          synced.current[cid] = page.nextSince;
          if (!page.hasMore) break;
        }
      } finally {
        resyncing.current.delete(cid);
      }
    },
    [upsert],
  );

  const load = useCallback(
    async (cid: string) => {
      if (loaded.current.has(cid)) return;
      loaded.current.add(cid);
      const c = await chatApi<Conversation>('GET', `conversations/${cid}`);
      const page = await chatApi<{ messages: Message[]; hasMore: boolean }>('GET', `conversations/${cid}/messages?limit=50`);
      synced.current[cid] = c.lastSeq;
      upsert(cid, page.messages);
      setHasMore((h) => ({ ...h, [cid]: page.hasMore }));
      setConvs((prev) => sortConversations([...prev.filter((x) => x.id !== c.id), c]));
      // Anything that changed between the two calls.
      await resync(cid);
    },
    [resync, upsert],
  );

  const onEvent = useCallback(
    (f: { type: string; data?: any }) => {
      const d = f.data;
      switch (f.type) {
        case 'message.created':
        case 'message.updated': {
          const m = d as Message;
          const cid = m.conversationId;
          if (loaded.current.has(cid)) {
            upsert(cid, [m]);
            // Each change moves the counter by one; a jump means we missed something.
            if (m.changeSeq > (synced.current[cid] ?? 0) + 1) void resync(cid);
            else synced.current[cid] = Math.max(synced.current[cid] ?? 0, m.changeSeq);
          }
          if (f.type === 'message.created' && m.senderId !== me.id) {
            const read = activeRef.current === cid && document.visibilityState === 'visible';
            rt.current?.frame({ type: 'receipt', conversationId: cid, kind: read ? 'read' : 'delivered', seq: m.seq });
            setTyping((t) => ({ ...t, [`${cid}:${m.senderId}`]: 0 }));
          }
          void refreshConversation(cid);
          break;
        }
        case 'message.hidden':
          upsert(d.conversationId, [], [d.id]);
          synced.current[d.conversationId] = Math.max(synced.current[d.conversationId] ?? 0, d.changeSeq);
          break;
        case 'receipt':
          setConvs((prev) =>
            prev.map((c) =>
              c.id !== d.conversationId
                ? c
                : {
                    ...c,
                    unreadCount: d.userId === me.id && d.lastReadSeq !== null ? 0 : c.unreadCount,
                    members: c.members.map((m) => (m.userId === d.userId ? { ...m, lastDeliveredSeq: d.lastDeliveredSeq, lastReadSeq: d.lastReadSeq } : m)),
                  },
            ),
          );
          break;
        case 'typing':
          setTyping((t) => ({ ...t, [`${d.conversationId}:${d.userId}`]: d.typing ? Date.now() + TYPING_TTL : 0 }));
          break;
        case 'presence':
          setPresence((p) => ({ ...p, [d.userId]: { online: d.online, lastSeenAt: d.lastSeenAt } }));
          break;
        case 'conversation.updated':
          void refreshConversation(d.id);
          break;
      }
    },
    [me.id, refreshConversation, resync, upsert],
  );

  useEffect(() => {
    const client = new RealtimeClient(wsBase, onEvent, setConn, () => {
      for (const cid of loaded.current) void resync(cid);
      void chatApi<{ conversations: Conversation[] }>('GET', 'conversations').then((r) =>
        setConvs((prev) => sortConversations([...prev.filter((c) => !r.conversations.some((x) => x.id === c.id)), ...r.conversations])),
      );
    });
    rt.current = client;
    client.start();
    return () => client.stop();
  }, [wsBase, onEvent, resync]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const active = convs.find((c) => c.id === activeId);
  const peer = peerOf(active, me.id);
  const activeMsgs = useMemo(() => (activeId ? (msgs[activeId] ?? []) : []), [activeId, msgs]);

  useEffect(() => {
    if (!activeId) return;
    load(activeId).catch((e) => setError(e.message));
  }, [activeId, load]);

  useEffect(() => {
    if (!peer) return;
    chatApi<{ userId: string; online: boolean | null; lastSeenAt: string | null }[]>('GET', `presence?userIds=${peer.userId}`)
      .then((r) => setPresence((p) => ({ ...p, [r[0].userId]: r[0] })))
      .catch(() => undefined);
  }, [peer?.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark what's on screen as read.
  const lastFromOthers = [...activeMsgs].reverse().find((m) => !m.pending && m.senderId !== me.id);
  const myRead = active?.members.find((m) => m.userId === me.id)?.lastReadSeq ?? 0;
  useEffect(() => {
    if (!activeId || !lastFromOthers || lastFromOthers.seq <= myRead) return;
    if (document.visibilityState !== 'visible' || conn !== 'online') return;
    rt.current?.frame({ type: 'receipt', conversationId: activeId, kind: 'read', seq: lastFromOthers.seq });
  }, [activeId, lastFromOthers?.seq, myRead, conn]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(
    async (cid: string, content: { kind: Message['kind']; body?: string; mediaId?: string; replyToId?: string; media?: Media | null }) => {
      const clientId = newClientId();
      const local: Message = {
        id: `local-${clientId}`,
        conversationId: cid,
        seq: 0,
        changeSeq: 0,
        senderId: me.id,
        clientId,
        kind: content.kind,
        body: content.body ?? '',
        media: content.media ?? null,
        replyTo: null,
        forwarded: false,
        mentions: [],
        reactions: [],
        editedAt: null,
        deletedAt: null,
        pinnedAt: null,
        createdAt: new Date().toISOString(),
        pending: 'sending',
      };
      upsert(cid, [local]);
      try {
        const ack = await rt.current!.send(cid, { clientId, kind: content.kind, body: content.body ?? '', mediaId: content.mediaId, replyToId: content.replyToId });
        upsert(cid, [ack.message]);
      } catch (e) {
        upsert(cid, [{ ...local, pending: 'failed' }]);
        setError(e instanceof Error ? e.message : 'Not sent');
      }
    },
    [me.id, upsert],
  );

  const act = useCallback(
    async (fn: () => Promise<Message | unknown>) => {
      try {
        const r = await fn();
        if (r && typeof r === 'object' && 'conversationId' in r) upsert((r as Message).conversationId, [r as Message]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong');
      }
    },
    [upsert],
  );

  const loadEarlier = async () => {
    if (!activeId) return;
    const first = activeMsgs.find((m) => !m.pending);
    const page = await chatApi<{ messages: Message[]; hasMore: boolean }>('GET', `conversations/${activeId}/messages?limit=50${first ? `&before=${first.seq}` : ''}`);
    upsert(activeId, page.messages);
    setHasMore((h) => ({ ...h, [activeId]: page.hasMore }));
  };

  const typingNow = active ? active.members.filter((m) => m.userId !== me.id && (typing[`${active.id}:${m.userId}`] ?? 0) > now) : [];
  const peerPresence = peer ? presence[peer.userId] : undefined;

  return (
    <div className="chat-shell">
      <aside className="chat-list">
        <div className="chat-list-head">
          <strong>Chats</strong>
          <span className={`conn ${conn}`} data-testid="conn">
            {conn === 'online' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : 'Offline, retrying'}
          </span>
        </div>
        <NewChat
          onOpen={async (username) => {
            const user = await chatApi<{ id: string }>('GET', `users/${encodeURIComponent(username.toLowerCase())}`);
            const c = await chatApi<Conversation>('POST', 'conversations/direct', { userId: user.id });
            setConvs((prev) => sortConversations([...prev.filter((x) => x.id !== c.id), c]));
            setActiveId(c.id);
          }}
        />
        <Search
          onPick={(m) => setActiveId(m.conversationId)}
          nameFor={(cid) => peerOf(convs.find((c) => c.id === cid), me.id)?.displayName ?? 'Chat'}
        />
        <ul className="conv-items">
          {convs
            .filter((c) => !c.archived)
            .map((c) => {
              const p = peerOf(c, me.id);
              return (
                <li key={c.id}>
                  <button className={`conv ${c.id === activeId ? 'active' : ''}`} data-testid={`conv-${p?.username}`} onClick={() => setActiveId(c.id)}>
                    <span className="conv-name">
                      {p?.displayName ?? 'Chat'} {c.mutedUntil && Date.parse(c.mutedUntil) > now && <small title="Muted">🔕</small>}
                    </span>
                    <span className="conv-preview muted">{preview(c.lastMessage)}</span>
                    {c.unreadCount > 0 && c.id !== activeId && (
                      <span className="badge" data-testid="unread">
                        {c.unreadCount}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
        </ul>
        {convs.some((c) => c.archived) && <ArchivedList convs={convs.filter((c) => c.archived)} me={me.id} onOpen={setActiveId} />}
      </aside>

      <section className="chat-main">
        {!active ? (
          <p className="muted empty">Start a chat by entering someone’s username.</p>
        ) : (
          <>
            <header className="chat-head">
              <div>
                <strong data-testid="peer-name">{peer?.displayName}</strong>
                <div className="muted small" data-testid="presence">
                  {typingNow.length ? (
                    <span data-testid="typing">typing…</span>
                  ) : peerPresence?.online ? (
                    'online'
                  ) : peerPresence?.lastSeenAt ? (
                    `last seen ${new Date(peerPresence.lastSeenAt).toLocaleString()}`
                  ) : (
                    ''
                  )}
                </div>
              </div>
              <div className="chat-head-actions">
                <button
                  className="btn quiet small"
                  onClick={() =>
                    act(() =>
                      chatApi('PATCH', `conversations/${active.id}`, {
                        mutedUntil: active.mutedUntil && Date.parse(active.mutedUntil) > now ? null : new Date(now + 8 * 3600_000).toISOString(),
                      }).then(() => refreshConversation(active.id)),
                    )
                  }
                >
                  {active.mutedUntil && Date.parse(active.mutedUntil) > now ? 'Unmute' : 'Mute 8h'}
                </button>
                <button className="btn quiet small" onClick={() => act(() => chatApi('PATCH', `conversations/${active.id}`, { archived: !active.archived }).then(() => refreshConversation(active.id)))}>
                  {active.archived ? 'Unarchive' : 'Archive'}
                </button>
              </div>
            </header>
            <PinnedBar messages={activeMsgs.filter((m) => m.pinnedAt && !m.deletedAt)} />
            <Thread
              me={me.id}
              messages={activeMsgs}
              conversation={active}
              conversations={convs}
              hasMore={!!hasMore[active.id]}
              onLoadEarlier={loadEarlier}
              act={act}
              onRetry={(m) => {
                upsert(active.id, [], [m.id]);
                void send(active.id, { kind: m.kind, body: m.body ?? '', mediaId: m.media?.id, media: m.media });
              }}
              onReply={(m) => setReplyTo(m)}
              onHide={(m) => act(() => chatApi('POST', `messages/${m.id}/hide`).then(() => upsert(active.id, [], [m.id])))}
            />
            <Composer
              key={active.id}
              replyTo={replyTo?.conversationId === active.id ? replyTo : null}
              onCancelReply={() => setReplyTo(null)}
              onTyping={(t) => rt.current?.frame({ type: 'typing', conversationId: active.id, typing: t })}
              onSend={async (content) => {
                setReplyTo(null);
                await send(active.id, { ...content, replyToId: replyTo?.conversationId === active.id ? replyTo.id : undefined });
              }}
              onError={setError}
            />
          </>
        )}
        {error && (
          <p className="error toast" role="alert" onClick={() => setError(null)}>
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

function preview(m: Message | null) {
  if (!m) return 'No messages yet';
  if (m.deletedAt) return 'Message deleted';
  if (m.kind === 'text') return m.body ?? '';
  return { image: '📷 Photo', video: '🎬 Video', audio: '🎵 Audio', voice: '🎤 Voice note', file: '📄 File' }[m.kind] + (m.body ? ` ${m.body}` : '');
}

function NewChat({ onOpen }: { onOpen: (username: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="new-chat"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await onOpen(value.trim().replace(/^@/, ''));
          setValue('');
        } catch (x) {
          setErr(x instanceof ChatApiError && x.status === 404 ? 'No one with that username' : 'Could not open chat');
        }
      }}
    >
      <input name="username" placeholder="Start chat: username" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Username to chat with" />
      <button className="btn small" type="submit">
        Open
      </button>
      {err && <small className="error">{err}</small>}
    </form>
  );
}

function Search({ onPick, nameFor }: { onPick: (m: Message) => void; nameFor: (cid: string) => string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  return (
    <div className="search">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return setResults(null);
          setResults((await chatApi<{ results: Message[] }>('GET', `messages/search?q=${encodeURIComponent(q)}`)).results);
        }}
      >
        <input name="q" placeholder="Search messages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search messages" />
      </form>
      {results && (
        <ul className="search-results" data-testid="search-results">
          {results.length === 0 && <li className="muted small">No matches</li>}
          {results.map((m) => (
            <li key={m.id}>
              <button
                className="conv"
                onClick={() => {
                  onPick(m);
                  setResults(null);
                }}
              >
                <span className="conv-name small">{nameFor(m.conversationId)}</span>
                <span className="conv-preview">{m.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArchivedList({ convs, me, onOpen }: { convs: Conversation[]; me: string; onOpen: (id: string) => void }) {
  return (
    <details className="archived">
      <summary className="muted small">Archived ({convs.length})</summary>
      {convs.map((c) => (
        <button key={c.id} className="conv" onClick={() => onOpen(c.id)}>
          <span className="conv-name">{peerOf(c, me)?.displayName}</span>
        </button>
      ))}
    </details>
  );
}

function PinnedBar({ messages }: { messages: Message[] }) {
  if (!messages.length) return null;
  return (
    <div className="pinned" data-testid="pinned">
      📌 {messages.map((m) => preview(m)).join(' · ')}
    </div>
  );
}

function Thread({
  me,
  messages,
  conversation,
  conversations,
  hasMore,
  onLoadEarlier,
  act,
  onRetry,
  onReply,
  onHide,
}: {
  me: string;
  messages: Message[];
  conversation: Conversation;
  conversations: Conversation[];
  hasMore: boolean;
  onLoadEarlier: () => void;
  act: (fn: () => Promise<unknown>) => void;
  onRetry: (m: Message) => void;
  onReply: (m: Message) => void;
  onHide: (m: Message) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [last?.id]);
  const peer = peerOf(conversation, me);
  const names = Object.fromEntries(conversation.members.map((m) => [m.userId, m.displayName]));

  return (
    <div className="thread" data-testid="thread">
      {hasMore && (
        <button className="btn quiet small load-earlier" onClick={onLoadEarlier}>
          Load earlier messages
        </button>
      )}
      {messages.map((m) => {
        const mine = m.senderId === me;
        const ticks = !mine || m.pending ? null : peer?.lastReadSeq != null && peer.lastReadSeq >= m.seq ? 'read' : (peer?.lastDeliveredSeq ?? 0) >= m.seq ? 'delivered' : 'sent';
        return (
          <div key={m.id} className={`msg ${mine ? 'mine' : ''}`} data-testid="msg" data-body={m.body ?? ''}>
            <div className="bubble">
              {m.forwarded && <div className="muted small">↪ Forwarded</div>}
              {m.replyTo && (
                <div className="quote small">
                  <strong>{names[m.replyTo.senderId] ?? 'Someone'}</strong> {m.replyTo.deleted ? <em>Message deleted</em> : m.replyTo.preview}
                </div>
              )}
              {m.deletedAt ? (
                <em className="muted">This message was deleted</em>
              ) : (
                <>
                  {m.media && <MediaView media={m.media} pending={!!m.pending} />}
                  {m.body && <span className="body">{m.body}</span>}
                </>
              )}
              <div className="meta small">
                {m.editedAt && !m.deletedAt && <span>edited · </span>}
                {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {m.pending === 'sending' && <span data-testid="ticks"> · sending…</span>}
                {m.pending === 'failed' && (
                  <button className="link-btn" onClick={() => onRetry(m)}>
                    · not sent, retry
                  </button>
                )}
                {ticks && (
                  <span className={`ticks ${ticks}`} data-testid="ticks" title={ticks}>
                    {' '}
                    {ticks === 'sent' ? '✓' : '✓✓'}
                    <span className="sr-only">{ticks}</span>
                  </span>
                )}
              </div>
              {m.reactions.length > 0 && (
                <div className="reactions" data-testid="reactions">
                  {m.reactions.map((r) => (
                    <span key={r.userId} title={names[r.userId]}>
                      {r.emoji}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {!m.pending && !m.deletedAt && (
              <MessageActions
                m={m}
                mine={mine}
                myReaction={m.reactions.find((r) => r.userId === me)?.emoji}
                others={conversations.filter((c) => c.id !== conversation.id)}
                me={me}
                act={act}
                onReply={() => onReply(m)}
                onHide={() => onHide(m)}
              />
            )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function MessageActions({
  m,
  mine,
  myReaction,
  others,
  me,
  act,
  onReply,
  onHide,
}: {
  m: Message;
  mine: boolean;
  myReaction?: string;
  others: Conversation[];
  me: string;
  act: (fn: () => Promise<unknown>) => void;
  onReply: () => void;
  onHide: () => void;
}) {
  return (
    <details className="actions">
      <summary aria-label="Message actions">⋯</summary>
      <div className="actions-menu">
        <button onClick={onReply}>Reply</button>
        <span className="quick">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} aria-label={`React ${e}`} onClick={() => act(() => chatApi('PUT', `messages/${m.id}/reaction`, { emoji: myReaction === e ? null : e }))}>
              {e}
            </button>
          ))}
        </span>
        {mine && m.kind === 'text' && Date.now() - Date.parse(m.createdAt) < 15 * 60_000 && (
          <button
            onClick={() => {
              const body = window.prompt('Edit message', m.body ?? '');
              if (body !== null && body !== m.body) act(() => chatApi('PATCH', `messages/${m.id}`, { body }));
            }}
          >
            Edit
          </button>
        )}
        <button onClick={() => act(() => chatApi('PUT', `messages/${m.id}/pin`, { pinned: !m.pinnedAt }))}>{m.pinnedAt ? 'Unpin' : 'Pin'}</button>
        {others.length > 0 && (
          <select
            aria-label="Forward to"
            defaultValue=""
            onChange={(e) => {
              const target = e.target.value;
              e.target.value = '';
              if (target) act(() => chatApi('POST', `messages/${m.id}/forward`, { conversationIds: [target], clientId: newClientId() }));
            }}
          >
            <option value="">Forward to…</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {peerOf(c, me)?.displayName}
              </option>
            ))}
          </select>
        )}
        {mine && <button onClick={() => window.confirm('Delete this message for everyone?') && act(() => chatApi('DELETE', `messages/${m.id}`))}>Delete for everyone</button>}
        <button onClick={onHide}>Delete for me</button>
      </div>
    </details>
  );
}

const urlCache = new Map<string, { url: string; until: number }>();

function MediaView({ media, pending }: { media: Media; pending: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (pending) return;
    const hit = urlCache.get(media.id);
    if (hit && hit.until > Date.now()) return setUrl(hit.url);
    chatApi<{ url: string; expiresIn: number }>('GET', `media/${media.id}`)
      .then((r) => {
        urlCache.set(media.id, { url: r.url, until: Date.now() + (r.expiresIn - 30) * 1000 });
        setUrl(r.url);
      })
      .catch(() => setUrl(null));
  }, [media.id, pending]);
  if (!url) return <div className="media-placeholder muted small">{pending ? 'Uploading…' : 'Loading…'}</div>;
  if (media.kind === 'image') return <img className="media" src={url} alt={media.fileName || 'Photo'} data-testid="media-image" />;
  if (media.kind === 'video') return <video className="media" src={url} controls preload="metadata" />;
  if (media.kind === 'audio' || media.kind === 'voice')
    return (
      <span className="voice">
        {media.kind === 'voice' && '🎤 '}
        <audio src={url} controls preload="metadata" />
        {media.durationMs && <small className="muted"> {Math.round(media.durationMs / 1000)}s</small>}
      </span>
    );
  return (
    <a href={url} className="file" rel="noopener noreferrer">
      📄 {media.fileName || 'File'} <small className="muted">({Math.ceil(media.byteSize / 1024)} KB)</small>
    </a>
  );
}

function Composer({
  replyTo: reply,
  onCancelReply,
  onTyping,
  onSend,
  onError,
}: {
  replyTo: Message | null;
  onCancelReply: () => void;
  onTyping: (typing: boolean) => void;
  onSend: (c: { kind: Message['kind']; body?: string; mediaId?: string; media?: Media }) => Promise<void>;
  onError: (e: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<{ rec: MediaRecorder; started: number } | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const typed = (v: string) => {
    setText(v);
    onTyping(true);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => onTyping(false), 3000);
  };

  const sendFile = async (file: Blob, meta: { kind: Media['kind']; fileName: string; durationMs?: number }) => {
    setBusy(true);
    try {
      const media = await uploadMedia(file, meta);
      await onSend({ kind: meta.kind, mediaId: media.id, media, body: meta.kind === 'voice' ? '' : text.trim() });
      if (meta.kind !== 'voice') setText('');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      recording.rec.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const rec = new MediaRecorder(stream, { mimeType: type });
      const chunks: Blob[] = [];
      const started = Date.now();
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(null);
        const blob = new Blob(chunks, { type });
        void sendFile(blob, { kind: 'voice', fileName: 'voice-note', durationMs: Math.max(1, Date.now() - started) });
      };
      rec.start();
      setRecording({ rec, started });
    } catch {
      onError('Microphone access was refused. Allow it in your browser settings to record voice notes.');
    }
  };

  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = text.trim();
        if (!body) return;
        setText('');
        onTyping(false);
        await onSend({ kind: 'text', body });
      }}
    >
      {reply && (
        <div className="reply-preview small">
          Replying to: {reply.body?.slice(0, 80) || preview(reply)}{' '}
          <button type="button" className="link-btn" onClick={onCancelReply}>
            cancel
          </button>
        </div>
      )}
      <div className="composer-row">
        <button type="button" className="btn quiet" aria-label="Attach a file" disabled={busy} onClick={() => fileRef.current?.click()}>
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void sendFile(f, { kind: kindForFile(f.type), fileName: f.name });
          }}
        />
        <input name="message" placeholder="Message" value={text} onChange={(e) => typed(e.target.value)} autoComplete="off" aria-label="Message" maxLength={4000} />
        <button type="button" className={`btn quiet ${recording ? 'recording' : ''}`} aria-label={recording ? 'Stop and send voice note' : 'Record a voice note'} onClick={toggleRecording} disabled={busy}>
          {recording ? '⏹' : '🎤'}
        </button>
        <button type="submit" className="btn" disabled={busy || !text.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}
