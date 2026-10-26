'use client';

import { useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import type { Profile } from '@/lib/social-client';
import { PostList } from '../../social/social-ui';

const FOLLOW_LABEL = { none: 'Follow', pending: 'Requested', active: 'Following' } as const;

export function ProfileView({ me, initial }: { me: string; initial: Profile }) {
  const [p, setP] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const self = p.id === me;
  const following = p.relationship?.following ?? 'none';
  // Private accounts show their posts only to approved followers.
  const canSeePosts = self || !p.privateAccount || following === 'active';
  return (
    <main className="wide social">
      <div className="card profile">
        <h1 data-testid="profile-name">{p.displayName}</h1>
        <p className="muted">
          @{p.username} {p.privateAccount && <span className="pill">Private</span>} {p.relationship?.followsYou && <span className="pill">Follows you</span>}
        </p>
        {p.statusText && <p>{p.statusText}</p>}
        {p.bio && <p>{p.bio}</p>}
        <p className="small">
          <strong data-testid="follower-count">{p.followerCount}</strong> followers · <strong>{p.followingCount}</strong> following
        </p>
        {!self && (
          <button
            className={`btn ${following === 'none' ? '' : 'quiet'}`}
            data-testid="follow-button"
            onClick={async () => {
              setErr(null);
              try {
                const rel = await chatApi<Profile['relationship']>(following === 'none' ? 'POST' : 'DELETE', `users/${p.id}/follow`);
                const delta = (rel!.following === 'active' ? 1 : 0) - (following === 'active' ? 1 : 0);
                setP({ ...p, relationship: rel, followerCount: p.followerCount + delta });
              } catch (e) {
                setErr(e instanceof Error ? e.message : 'Something went wrong');
              }
            }}
          >
            {FOLLOW_LABEL[following]}
          </button>
        )}
        {err && <p className="error small">{err}</p>}
      </div>
      {canSeePosts ? (
        <PostList key={`${p.id}:${following}`} source={`users/${p.id}/posts`} me={me} empty="No posts yet." />
      ) : (
        <p className="muted" data-testid="private-notice">
          This account is private. Follow it to see their posts.
        </p>
      )}
    </main>
  );
}
