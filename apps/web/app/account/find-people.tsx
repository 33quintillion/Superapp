'use client';

import { useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import { Avatar } from '../social/social-ui';

interface Match {
  matched: string;
  user: { id: string; username: string; displayName: string; avatarMediaId: string | null };
}

/**
 * Looks up email addresses or phone numbers the person types or pastes. Only people who
 * chose to be found that way show up, and nothing entered here is stored.
 */
export function FindPeople() {
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="card"
      data-testid="find-people"
      onSubmit={async (e) => {
        e.preventDefault();
        const entries = text.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
        if (!entries.length) return;
        setBusy(true);
        setError(null);
        try {
          const emails = entries.filter((x) => x.includes('@'));
          const phones = entries.filter((x) => !x.includes('@'));
          setMatches((await chatApi<{ matches: Match[] }>('POST', 'contacts/match', { emails, phones })).matches);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Something went wrong');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="contacts">Email addresses or phone numbers (with country code), one per line</label>
      <textarea id="contacts" name="contacts" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <p className="muted small">Only people who chose to be found by their email or number appear. What you enter isn’t saved.</p>
      <button className="btn" type="submit" disabled={busy}>
        Find
      </button>
      {matches && (
        <div aria-live="polite">
          {matches.length === 0 && <p className="muted">No one found.</p>}
          {matches.map((m) => (
            <div className="row" key={m.user.id} data-testid="found-person">
              <span className="photo-editor">
                <Avatar mediaId={m.user.avatarMediaId} name={m.user.displayName} size={32} />
                <a href={`/u/${m.user.username}`}>{m.user.displayName}</a>
              </span>
              <span className="muted small">{m.matched}</span>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
