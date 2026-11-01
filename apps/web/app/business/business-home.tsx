'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import { Business, CATEGORIES } from '@/lib/business-client';

function BusinessRow({ b, manage }: { b: Business; manage?: boolean }) {
  return (
    <Link href={manage ? `/business/${b.handle}` : `/b/${b.handle}`} className="row community-row" data-testid="business-row">
      <span>
        <strong>{b.name}</strong> <span className="muted small">@{b.handle}</span> {b.verified && <span className="pill">Verified</span>}
        {b.state === 'suspended' && <span className="pill error">Suspended</span>}
      </span>
      <span className="muted small">{manage && b.myRole ? `You: ${b.myRole}` : b.category}</span>
    </Link>
  );
}

export function BusinessHome({ mine }: { mine: Business[] }) {
  const router = useRouter();
  const [list, setList] = useState(mine);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Business[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const working = list.filter((b) => b.myRole);
  const invites = list.filter((b) => b.invited);
  const zone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

  return (
    <main className="wide social">
      <h1>Businesses</h1>
      <form
        className="composer-row"
        onSubmit={async (e) => {
          e.preventDefault();
          setFound((await chatApi<{ businesses: Business[] }>('GET', `businesses?q=${encodeURIComponent(q)}`)).businesses);
        }}
      >
        <input name="businessSearch" placeholder="Find shops, cafés, salons…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search businesses" />
        <button className="btn small" type="submit">
          Search
        </button>
      </form>
      {found && (
        <div className="card" data-testid="business-results">
          {found.length === 0 ? <p className="muted">No matches.</p> : found.map((b) => <BusinessRow key={b.id} b={b} />)}
        </div>
      )}

      {invites.length > 0 && (
        <>
          <h2>Invitations</h2>
          <div className="card">
            {invites.map((b) => (
              <div className="row" key={b.id} data-testid="business-invite">
                <span>
                  <strong>{b.name}</strong> asked you to join as {b.invited!.role}
                </span>
                <span className="actions">
                  <button
                    className="btn small"
                    onClick={async () => {
                      await chatApi('POST', `businesses/${b.id}/staff/accept`);
                      setList((await chatApi<{ businesses: Business[] }>('GET', 'me/businesses')).businesses);
                    }}
                  >
                    Accept
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Yours</h2>
      <div className="card">{working.length === 0 ? <p className="muted">You don’t run or work at a business here yet.</p> : working.map((b) => <BusinessRow key={b.id} b={b} manage />)}</div>

      {creating ? (
        <form
          className="card stack"
          data-testid="create-business"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            const f = new FormData(e.currentTarget);
            try {
              const b = await chatApi<Business>('POST', 'businesses', {
                name: f.get('name'),
                handle: f.get('handle'),
                description: f.get('description'),
                category: f.get('category'),
                address: f.get('address'),
                currency: String(f.get('currency')).toUpperCase(),
                timeZone: f.get('timeZone'),
              });
              router.push(`/business/${b.handle}`);
            } catch (x) {
              setErr(x instanceof Error ? x.message : 'Could not create it');
            }
          }}
        >
          <label className="field">
            <span>Business name</span>
            <input name="name" required maxLength={80} />
          </label>
          <label className="field">
            <span>Address on SuperApp</span>
            <input name="handle" required pattern="[a-z0-9][a-z0-9_\-]{2,39}" placeholder="e.g. corner-bakery" />
            <small>3-40 lowercase letters, numbers, - or _</small>
          </label>
          <label className="field">
            <span>What you do</span>
            <input name="description" maxLength={2000} />
          </label>
          <label className="field">
            <span>Category</span>
            <select name="category" defaultValue="food">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Street address</span>
            <input name="address" maxLength={300} />
          </label>
          <label className="field">
            <span>Currency</span>
            <input name="currency" required defaultValue="USD" pattern="[A-Za-z]{3}" maxLength={3} />
            <small>Three letters, e.g. USD, EUR, GBP, INR</small>
          </label>
          <label className="field">
            <span>Time zone</span>
            <input name="timeZone" required defaultValue={zone} />
            <small>Your opening hours and bookings use this</small>
          </label>
          <button className="btn" type="submit">
            Create business
          </button>
          {err && <p className="error">{err}</p>}
        </form>
      ) : (
        <button className="btn quiet" onClick={() => setCreating(true)}>
          Add your business
        </button>
      )}
    </main>
  );
}
