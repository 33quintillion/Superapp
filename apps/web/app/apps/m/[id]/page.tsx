import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { authed } from '@/lib/session';
import type { Item } from '@/lib/business-client';
import type { OpenedMini } from '@/lib/mini-client';
import { MiniView } from '../../mini-view';

export const dynamic = 'force-dynamic';

export default async function MiniProgramPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let m: OpenedMini;
  try {
    m = await authed<OpenedMini>('GET', `/v1/mini-programs/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const blocks = m.pages.flatMap((p) => p.blocks);
  const [items, hours] = await Promise.all([
    blocks.some((b) => b.type === 'items') ? authed<{ items: Item[] }>('GET', `/v1/businesses/${m.business.id}/items`).then((r) => r.items) : Promise.resolve([]),
    blocks.some((b) => b.type === 'hours') ? authed<{ hours: { weekday: number; opens: string; closes: string }[] }>('GET', `/v1/businesses/${m.business.id}/hours`).then((r) => r.hours) : Promise.resolve([]),
  ]);
  return (
    <main className="wide">
      <p className="small">
        <Link href="/apps">← Mini-programs</Link>
      </p>
      <MiniView program={m} business={m.business} data={{ items, hours }} />
    </main>
  );
}
