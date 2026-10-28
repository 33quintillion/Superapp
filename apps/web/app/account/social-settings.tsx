'use client';

import { useEffect, useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import type { UserSummary } from '@/lib/social-client';

interface Privacy {
  discoverableByEmail: boolean;
  privateAccount: boolean;
  whoCanAddToGroups: 'everyone' | 'following' | 'nobody';
}

/** Who can follow you and add you to groups, plus follow requests waiting for you. */
export function SocialSettings() {
  const [p, setP] = useState<Privacy | null>(null);
  const [requests, setRequests] = useState<{ user: UserSummary }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    Promise.all([chatApi<Privacy>('GET', 'me/privacy'), chatApi<{ requests: { user: UserSummary }[] }>('GET', 'me/follow-requests')])
      .then(([priv, reqs]) => {
        setP(priv);
        setRequests(reqs.requests);
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);
  const save = async (patch: Partial<Privacy>) => {
    setErr(null);
    try {
      setP(await chatApi<Privacy>('PATCH', 'me/privacy', patch));
      if (patch.privateAccount === false) await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    }
  };
  if (!p) return <p className="muted">{err ?? 'Loading…'}</p>;
  return (
    <div className="card" data-testid="social-settings">
      <label className="row">
        <span>
          Private account
          <br />
          <small className="muted">You approve each follower, and your posts and stories are for followers only.</small>
        </span>
        <input type="checkbox" name="privateAccount" checked={p.privateAccount} onChange={(e) => save({ privateAccount: e.target.checked })} />
      </label>
      <label className="row">
        <span>
          Let people who have my email address find me
          <br />
          <small className="muted">Off unless you turn it on. Only works once your email address is confirmed.</small>
        </span>
        <input type="checkbox" name="discoverableByEmail" checked={p.discoverableByEmail} onChange={(e) => save({ discoverableByEmail: e.target.checked })} />
      </label>
      <label className="row">
        <span>Who can add me to groups</span>
        <select name="whoCanAddToGroups" value={p.whoCanAddToGroups} onChange={(e) => save({ whoCanAddToGroups: e.target.value as Privacy['whoCanAddToGroups'] })}>
          <option value="everyone">Everyone</option>
          <option value="following">People I follow</option>
          <option value="nobody">Nobody</option>
        </select>
      </label>
      {requests.length > 0 && (
        <div data-testid="follow-requests">
          <strong>Follow requests</strong>
          {requests.map((r) => (
            <div className="row" key={r.user.id}>
              <span>
                {r.user.displayName} <span className="muted small">@{r.user.username}</span>
              </span>
              <span>
                {[true, false].map((approve) => (
                  <button
                    key={String(approve)}
                    className={`btn small ${approve ? '' : 'quiet'}`}
                    onClick={async () => {
                      try {
                        await chatApi('POST', `me/follow-requests/${r.user.id}`, { approve });
                        setRequests((list) => list.filter((x) => x.user.id !== r.user.id));
                      } catch (e) {
                        setErr(e instanceof Error ? e.message : 'Something went wrong');
                      }
                    }}
                  >
                    {approve ? 'Approve' : 'Decline'}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
      {err && <p className="error small">{err}</p>}
    </div>
  );
}
