'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import type { Community } from '@/lib/social-client';

function CommunityRow({ c }: { c: Community }) {
  return (
    <Link href={`/communities/${c.slug}`} className="row community-row" data-testid="community-row">
      <span>
        <strong>{c.name}</strong> <span className="muted small">/{c.slug}</span>
        {c.kind === 'channel' && <span className="pill">Channel</span>} {c.visibility === 'private' && <span className="pill">Private</span>}
      </span>
      <span className="muted small">
        {c.memberCount} {c.kind === 'channel' ? 'followers' : 'members'}
        {c.membership?.state === 'pending' && ' · requested'}
      </span>
    </Link>
  );
}

export function CommunitiesHome({ mine }: { mine: Community[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Community[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="wide social">
      <h1>Communities</h1>
      <form
        className="composer-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return setFound(null);
          setFound((await chatApi<{ communities: Community[] }>('GET', `communities?q=${encodeURIComponent(q)}`)).communities);
        }}
      >
        <input name="communitySearch" placeholder="Find communities and channels" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search communities" />
        <button className="btn small" type="submit">
          Search
        </button>
      </form>
      {found && (
        <div className="card" data-testid="community-results">
          {found.length === 0 ? <p className="muted">No matches.</p> : found.map((c) => <CommunityRow key={c.id} c={c} />)}
        </div>
      )}

      <h2>Yours</h2>
      <div className="card">{mine.length === 0 ? <p className="muted">You haven’t joined any yet.</p> : mine.map((c) => <CommunityRow key={c.id} c={c} />)}</div>

      {creating ? (
        <form
          className="card stack"
          data-testid="create-community"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            const f = new FormData(e.currentTarget);
            try {
              const c = await chatApi<Community>('POST', 'communities', {
                name: f.get('name'),
                slug: f.get('slug'),
                description: f.get('description'),
                kind: f.get('kind'),
                visibility: f.get('visibility'),
              });
              router.push(`/communities/${c.slug}`);
            } catch (x) {
              setErr(x instanceof Error ? x.message : 'Could not create it');
            }
          }}
        >
          <label className="field">
            <span>Name</span>
            <input name="name" required maxLength={80} />
          </label>
          <label className="field">
            <span>Address</span>
            <input name="slug" required pattern="[a-z0-9][a-z0-9_\-]{2,39}" placeholder="e.g. city-gardeners" />
            <small>3-40 lowercase letters, numbers, - or _</small>
          </label>
          <label className="field">
            <span>Description</span>
            <input name="description" maxLength={1000} />
          </label>
          <label className="field">
            <span>Type</span>
            <select name="kind" defaultValue="community">
              <option value="community">Community: members post and discuss</option>
              <option value="channel">Channel: only admins post, others follow</option>
            </select>
          </label>
          <label className="field">
            <span>Who can see it</span>
            <select name="visibility" defaultValue="public">
              <option value="public">Public: anyone can read and join</option>
              <option value="private">Private: you approve each member</option>
            </select>
          </label>
          <button className="btn" type="submit">
            Create
          </button>
          {err && <p className="error">{err}</p>}
        </form>
      ) : (
        <button className="btn quiet" style={{ marginTop: 'var(--space-lg)' }} onClick={() => setCreating(true)}>
          Create a community or channel
        </button>
      )}
    </main>
  );
}
