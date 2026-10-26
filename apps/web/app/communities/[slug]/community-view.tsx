'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import type { Community, CommunityRole, Post, UserSummary } from '@/lib/social-client';
import { PostComposer, PostList } from '../../social/social-ui';

const RANK: Record<CommunityRole, number> = { owner: 3, admin: 2, moderator: 1, member: 0 };
type MemberRow = { user: UserSummary; role: CommunityRole; since: string };

export function CommunityView({ me, initial }: { me: string; initial: Community }) {
  const [c, setC] = useState(initial);
  const [mine, setMine] = useState<Post[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const active = c.membership?.state === 'active';
  const role = active ? c.membership!.role : null;
  const isMod = !!role && RANK[role] >= RANK.moderator;
  const canPost = active && (c.kind === 'community' || (role !== null && RANK[role] >= RANK.admin));
  const canRead = c.visibility === 'public' || active;
  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  return (
    <main className="wide social">
      <div className="card">
        <h1 data-testid="community-name">{c.name}</h1>
        <p className="muted small">
          /{c.slug} · {c.kind === 'channel' ? 'Channel' : 'Community'} · {c.visibility === 'private' ? 'Private' : 'Public'} · <span data-testid="member-count">{c.memberCount}</span>{' '}
          {c.kind === 'channel' ? 'followers' : 'members'}
          {role && ` · You: ${role}`}
        </p>
        {c.description && <p>{c.description}</p>}
        {!c.membership && (
          <button className="btn" data-testid="join" onClick={() => act(async () => setC(await chatApi<Community>('POST', `communities/${c.id}/join`)))}>
            {c.visibility === 'private' ? 'Ask to join' : c.kind === 'channel' ? 'Follow' : 'Join'}
          </button>
        )}
        {c.membership?.state === 'pending' && <p className="muted" data-testid="join-pending">Your request is waiting for a moderator.</p>}
        {c.membership && role !== 'owner' && (
          <button
            className="btn quiet small"
            data-testid="leave"
            onClick={() =>
              act(async () => {
                await chatApi('DELETE', `communities/${c.id}/membership`);
                setC(await chatApi<Community>('GET', `communities/${c.id}`));
              })
            }
          >
            {c.membership.state === 'pending' ? 'Cancel request' : 'Leave'}
          </button>
        )}
        {err && <p className="error small">{err}</p>}
      </div>
      {isMod && <ModeratorPanel community={c} myRole={role!} me={me} onChanged={() => chatApi<Community>('GET', `communities/${c.id}`).then(setC)} />}
      {canPost && <PostComposer communityId={c.id} placeholder={c.kind === 'channel' ? 'Post an update to followers' : 'Start a discussion'} onPosted={(p) => setMine((m) => [p, ...m])} />}
      {canRead ? (
        <PostList key={`${c.id}:${c.membership?.state}`} source={`communities/${c.id}/posts`} me={me} moderator={isMod} prepend={mine} empty="No posts yet." />
      ) : (
        <p className="muted">Posts in this community are visible to members only.</p>
      )}
      <p className="small">
        <Link href="/communities">All communities</Link>
      </p>
    </main>
  );
}

function ModeratorPanel({ community: c, myRole, me, onChanged }: { community: Community; myRole: CommunityRole; me: string; onChanged: () => void }) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [pending, setPending] = useState<MemberRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [a, p] = await Promise.all([
      chatApi<{ members: MemberRow[] }>('GET', `communities/${c.id}/members?state=active`),
      chatApi<{ members: MemberRow[] }>('GET', `communities/${c.id}/members?state=pending`),
    ]);
    setMembers(a.members);
    setPending(p.members);
  }, [c.id]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  return (
    <details className="card" data-testid="moderator-panel" open={pending.length > 0}>
      <summary>
        Manage members {pending.length > 0 && <span className="pill" data-testid="pending-count">{pending.length} waiting</span>}
      </summary>
      {pending.map((m) => (
        <div className="row" key={m.user.id} data-testid="pending-member">
          <span>{m.user.displayName}</span>
          <span>
            <button className="btn small" data-testid="approve" onClick={() => run(() => chatApi('PATCH', `communities/${c.id}/members/${m.user.id}`, { state: 'active' }))}>
              Approve
            </button>{' '}
            <button className="btn quiet small" onClick={() => run(() => chatApi('DELETE', `communities/${c.id}/members/${m.user.id}`))}>
              Decline
            </button>
          </span>
        </div>
      ))}
      {members.map((m) => {
        const outranks = RANK[myRole] > RANK[m.role] && m.user.id !== me;
        return (
          <div className="row" key={m.user.id}>
            <span>
              {m.user.displayName} {m.role !== 'member' && <span className="pill">{m.role}</span>}
            </span>
            {outranks && (
              <span>
                {RANK[myRole] > RANK.moderator && (
                  <select
                    aria-label={`Role for ${m.user.displayName}`}
                    value={m.role}
                    onChange={(e) => run(() => chatApi('PATCH', `communities/${c.id}/members/${m.user.id}`, { role: e.target.value }))}
                  >
                    {(['member', 'moderator', 'admin'] as CommunityRole[])
                      .filter((r) => RANK[r] < RANK[myRole])
                      .map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                  </select>
                )}{' '}
                <button className="btn quiet small" onClick={() => window.confirm(`Ban ${m.user.displayName}?`) && run(() => chatApi('PATCH', `communities/${c.id}/members/${m.user.id}`, { state: 'banned' }))}>
                  Ban
                </button>
              </span>
            )}
          </div>
        );
      })}
      {err && <p className="error small">{err}</p>}
    </details>
  );
}
