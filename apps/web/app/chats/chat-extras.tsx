'use client';

import { useEffect, useRef, useState } from 'react';
import { chatApi, Conversation, Media, Message, MessageExtras } from '@/lib/chat-client';

/** WhatsApp's choices for disappearing messages. */
export const DISAPPEAR_CHOICES: { seconds: number | null; label: string }[] = [
  { seconds: null, label: 'Off' },
  { seconds: 86400, label: '24 hours' },
  { seconds: 604800, label: '7 days' },
  { seconds: 7776000, label: '90 days' },
];

export function disappearLabel(seconds: number | null | undefined) {
  return DISAPPEAR_CHOICES.find((c) => c.seconds === (seconds ?? null))?.label ?? `${Math.round((seconds ?? 0) / 86400)} days`;
}

/** A disappearing message whose time is up, or one the server has removed for that reason. */
export function disappeared(m: Message, now: number) {
  return !!m.expiresAt && (!!m.deletedAt || Date.parse(m.expiresAt) <= now);
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A poll: tap an option to vote (or take the vote back); counts and bars for everyone. */
export function PollView({ m, me, names, act }: { m: Message; me: string; names: Record<string, string>; act: (fn: () => Promise<unknown>) => void }) {
  const p = m.poll!;
  const mine = p.votes.filter((v) => v.userId === me).map((v) => v.option);
  const voters = new Set(p.votes.map((v) => v.userId)).size;
  const choose = (i: number) => {
    const next = p.multiple ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
    act(() => chatApi('PUT', `messages/${m.id}/vote`, { options: next }));
  };
  return (
    <fieldset className="poll" data-testid="poll">
      <legend className="poll-q">📊 {m.body}</legend>
      <p className="muted small poll-hint">{p.multiple ? 'Choose one or more' : 'Choose one'}</p>
      {p.options.map((o, i) => {
        const who = p.votes.filter((v) => v.option === i).map((v) => v.userId);
        const share = voters ? who.length / voters : 0;
        const picked = mine.includes(i);
        return (
          <button
            key={i}
            type="button"
            className={`poll-option ${picked ? 'picked' : ''}`}
            aria-pressed={picked}
            data-testid="poll-option"
            title={who.map((u) => (u === me ? 'You' : (names[u] ?? 'Someone'))).join(', ')}
            onClick={() => choose(i)}
          >
            <span className="poll-row">
              <span>
                {picked ? '☑' : '☐'} {o}
              </span>
              <strong data-testid="poll-count">{who.length}</strong>
            </span>
            <span className="poll-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
          </button>
        );
      })}
      <p className="muted small">
        {voters} {voters === 1 ? 'vote' : 'votes'}
      </p>
    </fieldset>
  );
}

/** A shared place, or a live location that keeps moving until it ends. */
export function LocationView({ m, mine, now, act }: { m: Message; mine: boolean; now: number; act: (fn: () => Promise<unknown>) => void }) {
  const l = m.location!;
  const live = !!l.liveUntil && Date.parse(l.liveUntil) > now;
  const map = `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=17/${l.lat}/${l.lng}`;
  return (
    <div className="location" data-testid="location">
      <a href={map} target="_blank" rel="noopener noreferrer" className="location-link">
        <span className="location-pin" aria-hidden="true">
          📍
        </span>
        <span>
          <strong>{l.label || (l.liveUntil ? 'Live location' : 'Location')}</strong>
          <span className="muted small location-coords">
            {l.lat.toFixed(5)}, {l.lng.toFixed(5)} · Open map
          </span>
        </span>
      </a>
      {l.liveUntil && (
        <p className={`small ${live ? 'live' : 'muted'}`} data-testid="live-status">
          {live ? `● Live until ${time(l.liveUntil)} · updated ${time(l.updatedAt)}` : 'Live location ended'}
          {live && mine && (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={() => act(() => chatApi('POST', `messages/${m.id}/location/stop`))}>
                Stop sharing
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export function ContactView({ m, me, onMessage }: { m: Message; me: string; onMessage: (userId: string) => void }) {
  const c = m.contact!;
  return (
    <div className="contact-card" data-testid="contact-card">
      <span className="avatar-dot" aria-hidden="true">
        {c.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span>
        <strong>{c.displayName}</strong>
        {c.username && <span className="muted small"> @{c.username}</span>}
      </span>
      {c.userId !== me && c.username && (
        <button type="button" className="btn quiet small" onClick={() => onMessage(c.userId)}>
          Message
        </button>
      )}
    </div>
  );
}

/** A view-once photo or video. Others open it once; the sender sees who has. */
export function ViewOnceView({ m, me, mine, names }: { m: Message; me: string; mine: boolean; names: Record<string, string> }) {
  const [shown, setShown] = useState<{ url: string; media: Media } | null>(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const what = m.media?.kind === 'video' ? 'Video' : 'Photo';
  const opened = m.openedBy ?? [];
  const usedUp = done || opened.includes(me);
  if (mine) {
    return (
      <p className="view-once small" data-testid="view-once">
        <span className="once-badge" aria-hidden="true">
          1
        </span>{' '}
        {what} · {opened.length ? `Opened by ${opened.map((u) => names[u] ?? 'someone').join(', ')}` : 'Not opened yet'}
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className="view-once"
        data-testid="view-once"
        disabled={usedUp}
        onClick={async () => {
          setErr(null);
          try {
            const r = await chatApi<{ url: string; media: Media }>('POST', `messages/${m.id}/open`);
            setDone(true);
            setShown(r);
          } catch (e) {
            setErr(e instanceof Error ? e.message : 'Couldn’t open it');
          }
        }}
      >
        <span className="once-badge" aria-hidden="true">
          1
        </span>{' '}
        {usedUp ? 'Opened' : `${what} · view once`}
      </button>
      {err && <small className="error">{err}</small>}
      {shown && (
        <div className="once-overlay" role="dialog" aria-label={`View-once ${what.toLowerCase()}`} data-testid="once-overlay">
          {shown.media.kind === 'video' ? (
            <video src={shown.url} autoPlay controls controlsList="nodownload" />
          ) : (
            <img src={shown.url} alt="View-once photo" onContextMenu={(e) => e.preventDefault()} draggable={false} />
          )}
          <button type="button" className="btn" autoFocus onClick={() => setShown(null)}>
            Close
          </button>
          <p className="small">This won’t be shown again.</p>
        </div>
      )}
    </>
  );
}

/** Polls, places, contact cards and view-once photos, from the composer's ➕ menu. */
export function ExtrasMenu({
  disabled,
  onSend,
  onViewOnce,
  onError,
}: {
  disabled: boolean;
  onSend: (c: { kind: Message['kind']; body?: string; extras: MessageExtras }) => Promise<void>;
  onViewOnce: () => void;
  onError: (e: string) => void;
}) {
  const [panel, setPanel] = useState<'menu' | 'poll' | 'location' | 'contact' | null>(null);
  const close = () => setPanel(null);
  return (
    <div className="extras">
      <button type="button" className="btn quiet" aria-label="More: poll, location, contact, view once" aria-expanded={!!panel} data-testid="extras" disabled={disabled} onClick={() => setPanel(panel ? null : 'menu')}>
        ➕
      </button>
      {panel === 'menu' && (
        <div className="extras-menu" role="menu">
          <button type="button" role="menuitem" data-testid="extra-poll" onClick={() => setPanel('poll')}>
            📊 Poll
          </button>
          <button type="button" role="menuitem" data-testid="extra-location" onClick={() => setPanel('location')}>
            📍 Location
          </button>
          <button type="button" role="menuitem" data-testid="extra-contact" onClick={() => setPanel('contact')}>
            👤 Contact
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="extra-view-once"
            onClick={() => {
              close();
              onViewOnce();
            }}
          >
            ① View-once photo or video
          </button>
        </div>
      )}
      {panel === 'poll' && <PollForm onCancel={close} onSend={async (c) => (await onSend(c), close())} />}
      {panel === 'location' && <LocationForm onCancel={close} onError={onError} onSend={async (c) => (await onSend(c), close())} />}
      {panel === 'contact' && <ContactForm onCancel={close} onSend={async (c) => (await onSend(c), close())} />}
    </div>
  );
}

function PollForm({ onSend, onCancel }: { onSend: (c: { kind: 'poll'; body: string; extras: MessageExtras }) => Promise<void>; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const dupes = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ready = !!q.trim() && filled.length >= 2 && !dupes;
  const submit = () => {
    if (ready) void onSend({ kind: 'poll', body: q.trim(), extras: { poll: { options: filled, multiple } } });
  };
  // Not a <form>: it sits inside the message composer's form, and forms can't nest.
  return (
    <div className="extras-panel" role="group" aria-label="New poll" data-testid="poll-form" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), submit())}>
      <strong>New poll</strong>
      <input name="pollQuestion" placeholder="Ask a question" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} aria-label="Question" />
      {options.map((o, i) => (
        <input
          key={i}
          name={`pollOption${i}`}
          placeholder={`Option ${i + 1}`}
          value={o}
          maxLength={100}
          aria-label={`Option ${i + 1}`}
          onChange={(e) => {
            const next = options.map((x, j) => (j === i ? e.target.value : x));
            // A new empty box appears as the last one is filled, up to 12.
            if (i === next.length - 1 && e.target.value && next.length < 12) next.push('');
            setOptions(next);
          }}
        />
      ))}
      <label className="small">
        <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> Allow more than one answer
      </label>
      {dupes && <small className="error">Each option must be different.</small>}
      <div className="extras-actions">
        <button type="button" className="btn quiet small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn small" data-testid="send-poll" disabled={!ready} onClick={submit}>
          Send poll
        </button>
      </div>
    </div>
  );
}

function LocationForm({ onSend, onCancel, onError }: { onSend: (c: { kind: 'location'; extras: MessageExtras }) => Promise<void>; onCancel: () => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const share = (liveMinutes?: 15 | 60 | 480) => {
    if (!navigator.geolocation) return onError('This browser can’t share its location.');
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        void onSend({ kind: 'location', extras: { location: { lat: round(pos.coords.latitude), lng: round(pos.coords.longitude), label: label.trim(), liveMinutes } } });
      },
      () => {
        setBusy(false);
        onError('Location access was refused. Allow it in your browser settings to share where you are.');
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  return (
    <div className="extras-panel" data-testid="location-form">
      <strong>Share location</strong>
      <input name="placeName" placeholder="Place name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} aria-label="Place name" />
      <button type="button" className="btn small" disabled={busy} onClick={() => share()}>
        {busy ? 'Finding you…' : 'Send my current location'}
      </button>
      <span className="small muted">Share live location (updates while this page stays open):</span>
      <div className="extras-actions">
        {([15, 60, 480] as const).map((m) => (
          <button key={m} type="button" className="btn quiet small" disabled={busy} onClick={() => share(m)}>
            {m === 15 ? '15 min' : m === 60 ? '1 hour' : '8 hours'}
          </button>
        ))}
      </div>
      <button type="button" className="btn quiet small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

function ContactForm({ onSend, onCancel }: { onSend: (c: { kind: 'contact'; extras: MessageExtras }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    const handle = name.trim().replace(/^@/, '').toLowerCase();
    if (!handle) return;
    try {
      const u = await chatApi<{ id: string }>('GET', `users/${encodeURIComponent(handle)}`);
      await onSend({ kind: 'contact', extras: { contactUserId: u.id } });
    } catch {
      setErr('No one with that username');
    }
  };
  return (
    <div className="extras-panel" role="group" aria-label="Share a contact" data-testid="contact-form" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void submit())}>
      <strong>Share a contact</strong>
      <input name="contactUsername" placeholder="Their username" value={name} onChange={(e) => setName(e.target.value)} aria-label="Username to share" />
      {err && <small className="error">{err}</small>}
      <div className="extras-actions">
        <button type="button" className="btn quiet small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn small" data-testid="send-contact" onClick={() => void submit()}>
          Send contact
        </button>
      </div>
    </div>
  );
}

/** The disappearing-messages timer in the chat header. */
export function DisappearingPicker({ c, act, onChanged }: { c: Conversation; act: (fn: () => Promise<unknown>) => void; onChanged: (c: Conversation) => void }) {
  const canChange = c.kind === 'direct' || c.group?.myRole !== 'member' || c.group?.infoPolicy === 'everyone';
  return (
    <label className="small disappearing" title="New messages disappear for everyone after this time">
      ⏱{' '}
      <select
        aria-label="Disappearing messages"
        data-testid="disappearing"
        value={String(c.disappearSeconds ?? '')}
        disabled={!canChange}
        onChange={(e) => {
          const seconds = e.target.value ? Number(e.target.value) : null;
          act(() => chatApi<Conversation>('PUT', `conversations/${c.id}/disappearing`, { seconds }).then(onChanged));
        }}
      >
        {DISAPPEAR_CHOICES.map((o) => (
          <option key={o.label} value={String(o.seconds ?? '')}>
            {o.seconds ? `Disappear after ${o.label}` : 'Disappearing off'}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Starred messages in this chat, newest star first. */
export function StarredPanel({ conversationId, names, version, onClose }: { conversationId: string; names: Record<string, string>; version: number; onClose: () => void }) {
  const [items, setItems] = useState<(Message & { starredAt: string })[] | null>(null);
  useEffect(() => {
    chatApi<{ messages: (Message & { starredAt: string })[] }>('GET', `messages/starred?conversationId=${conversationId}&limit=100`)
      .then((r) => setItems(r.messages))
      .catch(() => setItems([]));
  }, [conversationId, version]);
  return (
    <div className="group-panel" data-testid="starred-panel">
      <div className="extras-actions">
        <strong>★ Starred messages</strong>
        <button type="button" className="btn quiet small" onClick={onClose}>
          Close
        </button>
      </div>
      {!items ? (
        <p className="muted small">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted small">Nothing starred yet. Use ⋯ on a message, then Star.</p>
      ) : (
        <ul className="group-members">
          {items.map((m) => (
            <li key={m.id} data-testid="starred-item">
              <span>
                <strong className="small">{names[m.senderId] ?? 'Someone'}</strong> {m.body || describeKind(m)}
              </span>
              <span className="muted small">{new Date(m.createdAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { image: '📷 Photo', video: '🎬 Video', audio: '🎵 Audio', voice: '🎤 Voice note', file: '📄 File' };

export function describeKind(m: Pick<Message, 'kind' | 'viewOnce' | 'location' | 'contact' | 'body'>) {
  if (m.viewOnce) return m.kind === 'video' ? '① Video' : '① Photo';
  switch (m.kind) {
    case 'poll':
      return `📊 ${m.body ?? 'Poll'}`;
    case 'location':
      return m.location?.liveUntil ? '📍 Live location' : '📍 Location';
    case 'contact':
      return `👤 ${m.contact?.displayName ?? 'Contact'}`;
    default:
      return KIND_LABEL[m.kind] ?? '';
  }
}

/**
 * While this page is open, keeps the person's live locations moving: one update every 20
 * seconds at most, until each share ends or is stopped.
 */
export function useLiveLocation(messages: Message[], me: string, now: number) {
  const watch = useRef<number | null>(null);
  const lastSent = useRef(0);
  const liveIds = messages
    .filter((m) => m.senderId === me && !m.deletedAt && m.kind === 'location' && m.location?.liveUntil && Date.parse(m.location.liveUntil) > now)
    .map((m) => m.id);
  const key = liveIds.join(',');
  useEffect(() => {
    if (!liveIds.length || !navigator.geolocation) return;
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (Date.now() - lastSent.current < 20_000) return;
        lastSent.current = Date.now();
        for (const id of liveIds) {
          void chatApi('PUT', `messages/${id}/location`, { lat: round(pos.coords.latitude), lng: round(pos.coords.longitude) }).catch(() => undefined);
        }
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => {
      if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
