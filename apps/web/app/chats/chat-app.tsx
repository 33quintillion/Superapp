'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChatApiError,
  chatApi,
  ConnectionState,
  Conversation,
  GroupRole,
  kindForFile,
  Media,
  Message,
  newClientId,
  RealtimeClient,
  SystemEvent,
  uploadMedia,
} from '@/lib/chat-client';
import { CallManager, CallView } from '@/lib/call-session';
import { loadOutbox, OutboxEntry, saveOutbox } from '@/lib/outbox-store';
import { CallHistory, CallScreen, describeCall } from './call-ui';

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
  return c?.kind === 'direct' ? c.members.find((m) => m.userId !== me) : undefined;
}

function titleOf(c: Conversation | undefined, me: string) {
  if (!c) return 'Chat';
  return c.kind === 'group' ? c.title || 'Group' : (peerOf(c, me)?.displayName ?? 'Chat');
}

/** One sentence for a group notice, from the viewer's point of view. */
export function describeSystem(e: SystemEvent, actorId: string, me: string, names: Record<string, string>) {
  const who = (id: string) => (id === me ? 'You' : (names[id] ?? 'Someone'));
  const whom = (id: string) => (id === me ? 'you' : (names[id] ?? 'someone'));
  const actor = who(actorId);
  switch (e.type) {
    case 'group_created':
      return `${actor} created the group “${e.title}”`;
    case 'members_added':
      return `${actor} added ${e.userIds.map(whom).join(', ')}`;
    case 'member_removed':
      return `${actor} removed ${whom(e.userId)}`;
    case 'member_left':
      return `${actor} left`;
    case 'role_changed':
      return e.role === 'owner' ? `${who(e.userId)} now own${e.userId === me ? '' : 's'} the group` : e.role === 'admin' ? `${actor} made ${whom(e.userId)} an admin` : `${actor} removed ${whom(e.userId)} as admin`;
    case 'group_updated':
      return e.title !== undefined ? `${actor} renamed the group to “${e.title}”` : `${actor} changed the group settings`;
    case 'call':
      return describeCall(e, actorId, me);
  }
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
  const [showInfo, setShowInfo] = useState(false);
  const [callView, setCallView] = useState<CallView | null>(null);
  const [showCalls, setShowCalls] = useState(false);
  const [callsKey, setCallsKey] = useState(0);
  const calls = useRef<CallManager | null>(null);
  const convsRef = useRef(convs);
  convsRef.current = convs;

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
        case 'conversation.changed':
          void refreshConversation(d.id);
          break;
        case 'call.updated':
          if (d?.state === 'ended') setCallsKey((k) => k + 1);
          calls.current?.onEvent(f);
          break;
        case 'call.signal':
          calls.current?.onEvent(f);
          break;
        case 'conversation.removed':
          setConvs((prev) => prev.filter((c) => c.id !== d.id));
          setActiveId((id) => (id === d.id ? null : id));
          loaded.current.delete(d.id);
          break;
      }
    },
    [me.id, refreshConversation, resync, upsert],
  );

  useEffect(() => {
    const client = new RealtimeClient(wsBase, onEvent, setConn, () => {
      void calls.current?.onReady();
      for (const cid of loaded.current) void resync(cid);
      void chatApi<{ conversations: Conversation[] }>('GET', 'conversations').then((r) =>
        setConvs((prev) => sortConversations([...prev.filter((c) => !r.conversations.some((x) => x.id === c.id)), ...r.conversations])),
      );
    });
    rt.current = client;
    const manager = new CallManager(
      client,
      me.id,
      ({ conversationId, peerId }) => {
        const c = convsRef.current.find((x) => x.id === conversationId);
        return c?.members.find((m) => m.userId === peerId)?.displayName ?? 'Someone';
      },
      setCallView,
    );
    calls.current = manager;
    client.start();
    return () => {
      manager.dispose();
      client.stop();
    };
  }, [wsBase, onEvent, resync, me.id]);

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

  /** Shows a message as sending and hands it to the connection, which re-sends it after each reconnect. */
  const deliver = useCallback(
    async (e: OutboxEntry) => {
      const local: Message = {
        id: `local-${e.clientId}`,
        conversationId: e.conversationId,
        seq: 0,
        changeSeq: 0,
        senderId: me.id,
        clientId: e.clientId,
        kind: e.kind,
        body: e.body,
        media: e.media ?? null,
        replyTo: null,
        forwarded: false,
        mentions: [],
        system: null,
        reactions: [],
        editedAt: null,
        deletedAt: null,
        pinnedAt: null,
        createdAt: e.createdAt,
        pending: 'sending',
      };
      upsert(e.conversationId, [local]);
      try {
        const ack = await rt.current!.send(e.conversationId, { clientId: e.clientId, kind: e.kind, body: e.body, mediaId: e.mediaId, replyToId: e.replyToId });
        upsert(e.conversationId, [ack.message]);
      } catch (err) {
        upsert(e.conversationId, [{ ...local, pending: 'failed' }]);
        setError(err instanceof Error ? err.message : 'Not sent');
      }
      saveOutbox(me.id, loadOutbox(me.id).filter((x) => x.clientId !== e.clientId));
    },
    [me.id, upsert],
  );

  const send = useCallback(
    async (cid: string, content: { kind: Message['kind']; body?: string; mediaId?: string; replyToId?: string; media?: Media | null }) => {
      const e: OutboxEntry = {
        conversationId: cid,
        clientId: newClientId(),
        kind: content.kind,
        body: content.body ?? '',
        mediaId: content.mediaId,
        replyToId: content.replyToId,
        media: content.media ?? null,
        createdAt: new Date().toISOString(),
      };
      // Saved first, so closing the tab before the server answers doesn't lose it.
      saveOutbox(me.id, [...loadOutbox(me.id), e]);
      await deliver(e);
    },
    [me.id, deliver],
  );

  // Messages left unsent when this browser last closed go out again with their original ids,
  // once per connection client.
  const resentFor = useRef<RealtimeClient | null>(null);
  useEffect(() => {
    if (!rt.current || resentFor.current === rt.current) return;
    resentFor.current = rt.current;
    for (const e of loadOutbox(me.id)) void deliver(e);
  }, [deliver, me.id]);

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
    <main className="chat-shell">
      <aside className="chat-list">
        <div className="chat-list-head">
          <h1 className="chat-title">Chats</h1>
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
        <NewGroup
          onCreate={async (title, usernames) => {
            const ids = [];
            for (const u of usernames) ids.push((await chatApi<{ id: string }>('GET', `users/${encodeURIComponent(u.toLowerCase())}`)).id);
            const c = await chatApi<Conversation>('POST', 'conversations/groups', { title, memberIds: ids });
            setConvs((prev) => sortConversations([...prev.filter((x) => x.id !== c.id), c]));
            setActiveId(c.id);
          }}
        />
        <button className="btn quiet small calls-toggle" data-testid="calls-toggle" aria-expanded={showCalls} onClick={() => setShowCalls((v) => !v)}>
          {showCalls ? 'Back to chats' : 'Calls'}
        </button>
        {showCalls && (
          <CallHistory
            refreshKey={callsKey}
            onCall={async (peerId, media) => {
              try {
                const c = await chatApi<Conversation>('POST', 'conversations/direct', { userId: peerId });
                setConvs((prev) => sortConversations([...prev.filter((x) => x.id !== c.id), c]));
                setActiveId(c.id);
                await calls.current?.start(c.id, peerId, media);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Couldn’t call');
              }
            }}
          />
        )}
        <Search onPick={(m) => setActiveId(m.conversationId)} nameFor={(cid) => titleOf(convs.find((c) => c.id === cid), me.id)} />
        <ul className="conv-items">
          {convs
            .filter((c) => !c.archived)
            .map((c) => {
              const p = peerOf(c, me.id);
              return (
                <li key={c.id}>
                  <button className={`conv ${c.id === activeId ? 'active' : ''}`} data-testid={c.kind === 'group' ? `conv-group` : `conv-${p?.username}`} onClick={() => setActiveId(c.id)}>
                    <span className="conv-name">
                      {c.kind === 'group' && '👥 '}
                      {titleOf(c, me.id)} {c.mutedUntil && Date.parse(c.mutedUntil) > now && <small title="Muted">🔕</small>}
                    </span>
                    <span className="conv-preview muted">{preview(c.lastMessage, c, me.id)}</span>
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
                <strong data-testid="peer-name">{titleOf(active, me.id)}</strong>
                <div className="muted small" data-testid="presence">
                  {typingNow.length ? (
                    <span data-testid="typing">{active.kind === 'group' ? `${typingNow.map((m) => m.displayName).join(', ')} typing…` : 'typing…'}</span>
                  ) : active.kind === 'group' ? (
                    `${active.members.length} members`
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
                {active.kind === 'direct' && peer && (
                  <>
                    <button className="btn quiet small" data-testid="voice-call" aria-label={`Voice call ${peer.displayName}`} onClick={() => void calls.current?.start(active.id, peer.userId, 'audio')}>
                      📞 Call
                    </button>
                    <button className="btn quiet small" data-testid="video-call" aria-label={`Video call ${peer.displayName}`} onClick={() => void calls.current?.start(active.id, peer.userId, 'video')}>
                      🎥 Video
                    </button>
                  </>
                )}
                {active.kind === 'group' && (
                  <button className="btn quiet small" data-testid="group-info-toggle" onClick={() => setShowInfo((v) => !v)}>
                    {showInfo ? 'Close info' : 'Group info'}
                  </button>
                )}
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
            {active.kind === 'group' && showInfo && (
              <GroupPanel
                conversation={active}
                me={me.id}
                onChanged={(c) => setConvs((prev) => sortConversations([...prev.filter((x) => x.id !== c.id), c]))}
                onLeft={() => {
                  setConvs((prev) => prev.filter((c) => c.id !== active.id));
                  setActiveId(null);
                  setShowInfo(false);
                }}
                onError={setError}
              />
            )}
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
            {active.group?.sendPolicy === 'admins' && active.group.myRole === 'member' ? (
              <p className="composer muted small" data-testid="admins-only">
                Only admins can send messages in this group.
              </p>
            ) : (
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
            )}
          </>
        )}
        {callView && calls.current && <CallScreen view={callView} calls={calls.current} />}
        {error && (
          <p className="error toast" role="alert" onClick={() => setError(null)}>
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

function preview(m: Message | null, c?: Conversation, me = '') {
  if (!m) return 'No messages yet';
  if (m.deletedAt) return 'Message deleted';
  if (m.kind === 'system') return m.system && c ? describeSystem(m.system, m.senderId, me, Object.fromEntries(c.members.map((x) => [x.userId, x.displayName]))) : 'Group updated';
  if (m.kind === 'text') return c?.kind === 'group' && m.senderId !== me ? `${c.members.find((x) => x.userId === m.senderId)?.displayName ?? 'Someone'}: ${m.body ?? ''}` : (m.body ?? '');
  const label = { image: '📷 Photo', video: '🎬 Video', audio: '🎵 Audio', voice: '🎤 Voice note', file: '📄 File' }[m.kind];
  const text = label + (m.body ? ` ${m.body}` : '');
  if (c?.kind === 'group' && m.senderId !== me) return `${c.members.find((x) => x.userId === m.senderId)?.displayName ?? 'Someone'}: ${text}`;
  return text;
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
          <span className="conv-name">{titleOf(c, me)}</span>
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
  const others = conversation.members.filter((m) => m.userId !== me);
  const group = conversation.kind === 'group';
  // In groups a tick turns "read" once everyone who shares read receipts has read it.
  const readBy = (seq: number) => (group ? others.length > 0 && others.every((o) => o.lastReadSeq === null || o.lastReadSeq >= seq) && others.some((o) => o.lastReadSeq !== null) : peer?.lastReadSeq != null && peer.lastReadSeq >= seq);
  const deliveredTo = (seq: number) => (group ? others.every((o) => o.lastDeliveredSeq >= seq) : (peer?.lastDeliveredSeq ?? 0) >= seq);

  return (
    <div className="thread" data-testid="thread">
      {hasMore && (
        <button className="btn quiet small load-earlier" onClick={onLoadEarlier}>
          Load earlier messages
        </button>
      )}
      {messages.map((m, i) => {
        if (m.kind === 'system') {
          return (
            <div key={m.id} className="system-note small muted" data-testid="system-note">
              {m.system ? describeSystem(m.system, m.senderId, me, names) : 'Group updated'}
            </div>
          );
        }
        const mine = m.senderId === me;
        const ticks = !mine || m.pending ? null : readBy(m.seq) ? 'read' : deliveredTo(m.seq) ? 'delivered' : 'sent';
        const showName = group && !mine && messages[i - 1]?.senderId !== m.senderId;
        return (
          <div key={m.id} className={`msg ${mine ? 'mine' : ''}`} data-testid="msg" data-body={m.body ?? ''}>
            <div className="bubble">
              {showName && <strong className="small sender">{names[m.senderId] ?? 'Former member'}</strong>}
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
                {titleOf(c, me)}
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

function NewGroup({ onCreate }: { onCreate: (title: string, usernames: string[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [people, setPeople] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!open) {
    return (
      <div className="new-chat">
        <button className="btn quiet small" data-testid="new-group" onClick={() => setOpen(true)}>
          New group
        </button>
      </div>
    );
  }
  return (
    <form
      className="new-chat"
      data-testid="new-group-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        const usernames = people
          .split(/[\s,]+/)
          .map((u) => u.replace(/^@/, ''))
          .filter(Boolean);
        try {
          await onCreate(title.trim(), usernames);
          setTitle('');
          setPeople('');
          setOpen(false);
        } catch (x) {
          setErr(
            x instanceof ChatApiError && x.status === 404
              ? 'One of those usernames doesn’t exist'
              : x instanceof ChatApiError && x.code === 'cannot_add'
                ? 'Some of those people don’t allow you to add them to groups'
                : 'Could not create the group',
          );
        }
      }}
    >
      <input name="groupTitle" placeholder="Group name" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} aria-label="Group name" />
      <input name="groupMembers" placeholder="Usernames, separated by commas" value={people} onChange={(e) => setPeople(e.target.value)} aria-label="People to add" />
      <button className="btn small" type="submit">
        Create
      </button>
      <button className="btn quiet small" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {err && <small className="error">{err}</small>}
    </form>
  );
}

const ROLE_LABEL: Record<GroupRole, string> = { owner: 'Owner', admin: 'Admin', member: '' };

/** Members, roles and settings. Buttons only appear for what the server will allow. */
function GroupPanel({
  conversation: c,
  me,
  onChanged,
  onLeft,
  onError,
}: {
  conversation: Conversation;
  me: string;
  onChanged: (c: Conversation) => void;
  onLeft: () => void;
  onError: (e: string) => void;
}) {
  const g = c.group!;
  const isAdmin = g.myRole !== 'member';
  const canEdit = isAdmin || g.infoPolicy === 'everyone';
  const canAdd = isAdmin || g.addPolicy === 'everyone';
  const [adding, setAdding] = useState('');
  const run = async (fn: () => Promise<Conversation | void>) => {
    try {
      const r = await fn();
      if (r) onChanged(r);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  const patch = (body: Record<string, unknown>) => run(() => chatApi<Conversation>('PATCH', `conversations/${c.id}/group`, body));
  return (
    <div className="group-panel" data-testid="group-panel">
      {g.description && <p className="small">{g.description}</p>}
      {canEdit && (
        <button
          className="btn quiet small"
          onClick={() => {
            const title = window.prompt('Group name', c.title);
            if (title && title.trim() && title !== c.title) void patch({ title: title.trim() });
          }}
        >
          Rename
        </button>
      )}
      {isAdmin && (
        <div className="group-policies small">
          <label>
            <input type="checkbox" name="adminsOnlySend" checked={g.sendPolicy === 'admins'} onChange={(e) => patch({ sendPolicy: e.target.checked ? 'admins' : 'everyone' })} /> Only admins can send
          </label>
          <label>
            <input type="checkbox" checked={g.addPolicy === 'everyone'} onChange={(e) => patch({ addPolicy: e.target.checked ? 'everyone' : 'admins' })} /> Anyone can add people
          </label>
          <label>
            <input type="checkbox" checked={g.infoPolicy === 'everyone'} onChange={(e) => patch({ infoPolicy: e.target.checked ? 'everyone' : 'admins' })} /> Anyone can edit the name
          </label>
        </div>
      )}
      <ul className="group-members">
        {c.members.map((m) => {
          const canPromote = isAdmin && m.role === 'member';
          const canDemote = g.myRole === 'owner' && m.role === 'admin';
          const canRemove = m.userId !== me && m.role !== 'owner' && (g.myRole === 'owner' || (g.myRole === 'admin' && m.role === 'member'));
          return (
            <li key={m.userId} data-testid="group-member" data-username={m.username ?? ''}>
              <span>
                {m.userId === me ? 'You' : m.displayName} {ROLE_LABEL[m.role] && <span className="pill">{ROLE_LABEL[m.role]}</span>}
              </span>
              {m.userId !== me && (
                <span className="group-member-actions">
                  {canPromote && (
                    <button className="link-btn small" onClick={() => run(() => chatApi('PATCH', `conversations/${c.id}/members/${m.userId}`, { role: 'admin' }))}>
                      Make admin
                    </button>
                  )}
                  {canDemote && (
                    <button className="link-btn small" onClick={() => run(() => chatApi('PATCH', `conversations/${c.id}/members/${m.userId}`, { role: 'member' }))}>
                      Remove admin
                    </button>
                  )}
                  {canRemove && (
                    <button
                      className="link-btn small"
                      onClick={() =>
                        window.confirm(`Remove ${m.displayName} from the group?`) &&
                        run(async () => {
                          await chatApi('DELETE', `conversations/${c.id}/members/${m.userId}`);
                          return chatApi<Conversation>('GET', `conversations/${c.id}`);
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {canAdd && (
        <form
          className="new-chat"
          onSubmit={(e) => {
            e.preventDefault();
            const name = adding.trim().replace(/^@/, '');
            if (!name) return;
            void run(async () => {
              const u = await chatApi<{ id: string }>('GET', `users/${encodeURIComponent(name.toLowerCase())}`);
              const r = await chatApi<Conversation>('POST', `conversations/${c.id}/members`, { userIds: [u.id] });
              setAdding('');
              return r;
            });
          }}
        >
          <input name="addMember" placeholder="Add by username" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add someone by username" />
          <button className="btn small" type="submit">
            Add
          </button>
        </form>
      )}
      <button
        className="btn quiet small danger"
        onClick={() =>
          window.confirm('Leave this group?') &&
          run(async () => {
            await chatApi('DELETE', `conversations/${c.id}/members/${me}`);
            onLeft();
          })
        }
      >
        Leave group
      </button>
    </div>
  );
}
