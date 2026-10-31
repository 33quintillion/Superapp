import Link from 'next/link';
import { authed } from '@/lib/session';
import type { Integration } from '@/lib/business-client';
import type { MiniCard } from '@/lib/mini-client';
import { AppsCatalogue } from './apps-catalogue';

export const dynamic = 'force-dynamic';

function Cards({ items, testId }: { items: MiniCard[]; testId: string }) {
  return (
    <ul className="mini-cards" data-testid={testId}>
      {items.map((m) => (
        <li key={m.id}>
          <Link href={`/apps/m/${m.id}`} className={`mini-card accent-${m.accent}`}>
            <span className="mini-icon" aria-hidden="true">
              {m.icon}
            </span>
            <span>
              <strong>{m.name}</strong>
              <span className="muted small">
                {m.business.name}
                {m.business.verified && ' ✓'}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function AppsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? '').trim().slice(0, 100);
  const [catalogue, connected, minis, recent] = await Promise.all([
    authed<{ integrations: Integration[] }>('GET', '/v1/integrations'),
    authed<{ integrations: Integration[] }>('GET', '/v1/me/integrations'),
    authed<{ miniPrograms: MiniCard[] }>('GET', `/v1/mini-programs${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    authed<{ miniPrograms: MiniCard[] }>('GET', '/v1/me/mini-programs/recent'),
  ]);
  return (
    <AppsCatalogue catalogue={catalogue.integrations} connected={connected.integrations}>
      <section aria-labelledby="mini-title" className="mini-section">
        <h1 id="mini-title">Mini-programs</h1>
        <p className="muted">Small apps from businesses on SuperApp: menus, ordering, bookings and more.</p>
        <form className="new-chat" action="/apps" method="get">
          <input name="q" defaultValue={q} placeholder="Search mini-programs" aria-label="Search mini-programs" />
          <button className="btn small" type="submit">
            Search
          </button>
        </form>
        {!q && recent.miniPrograms.length > 0 && (
          <>
            <h2>Recently used</h2>
            <Cards items={recent.miniPrograms} testId="mini-recent" />
          </>
        )}
        <h2>{q ? `Results for “${q}”` : 'All mini-programs'}</h2>
        {minis.miniPrograms.length ? <Cards items={minis.miniPrograms} testId="mini-list" /> : <p className="muted">None yet.</p>}
      </section>
    </AppsCatalogue>
  );
}
