'use client';

import { useEffect, useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import type { Business, Item } from '@/lib/business-client';
import { type Accent, type Action, ACCENTS, ACTION_LABELS, type Block, BLOCK_LABELS, type MiniProgram, type StaffMini, starterProgram } from '@/lib/mini-client';
import { MiniView } from '../../apps/mini-view';

const BLANK: Record<Block['type'], () => Block> = {
  heading: () => ({ type: 'heading', text: 'New heading' }),
  text: () => ({ type: 'text', text: 'Write something here.' }),
  button: () => ({ type: 'button', label: 'Order now', action: { type: 'order' } }),
  items: () => ({ type: 'items', title: '' }),
  hours: () => ({ type: 'hours' }),
  location: () => ({ type: 'location', lat: 23.12, lng: 72.04, label: '' }),
  divider: () => ({ type: 'divider' }),
};

/**
 * The mini-program builder: pages made of blocks, a live preview, Save and Publish. Customers
 * see only what was last published. Staff who can't edit the business see it read-only.
 */
export function MiniEditor({ b }: { b: Business }) {
  const canEdit = b.permissions.includes('business.edit');
  const [saved, setSaved] = useState<StaffMini | null | undefined>(undefined);
  const [p, setP] = useState<MiniProgram | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [data, setData] = useState<{ items: Item[]; hours: { weekday: number; opens: string; closes: string }[] }>({ items: [], hours: [] });

  useEffect(() => {
    chatApi<{ miniProgram: StaffMini | null }>('GET', `businesses/${b.id}/mini-program`).then((r) => {
      setSaved(r.miniProgram);
      setP(r.miniProgram?.draft ?? starterProgram(b.name));
    });
    Promise.all([
      chatApi<{ items: Item[] }>('GET', `businesses/${b.id}/items`),
      chatApi<{ hours: { weekday: number; opens: string; closes: string }[] }>('GET', `businesses/${b.id}/hours`),
    ])
      .then(([i, h]) => setData({ items: i.items, hours: h.hours }))
      .catch(() => undefined);
  }, [b.id, b.name]);

  if (!p || saved === undefined) return <p className="muted">Loading…</p>;
  const page = p.pages[Math.min(pageIdx, p.pages.length - 1)];
  const dirty = JSON.stringify(p) !== JSON.stringify(saved?.draft ?? null);
  const unpublished = !!saved && JSON.stringify(saved.draft) !== JSON.stringify(saved.published);

  const setPage = (blocks: Block[], extra: Partial<typeof page> = {}) =>
    setP({ ...p, pages: p.pages.map((x) => (x.id === page.id ? { ...x, ...extra, blocks } : x)) });
  const setBlock = (i: number, blk: Block) => setPage(page.blocks.map((x, j) => (j === i ? blk : x)));
  const move = (i: number, by: number) => {
    const next = [...page.blocks];
    const [x] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, x);
    setPage(next);
  };

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Something went wrong' });
    } finally {
      setBusy(false);
    }
  };
  const save = () => chatApi<StaffMini>('PUT', `businesses/${b.id}/mini-program`, p).then(setSaved);

  return (
    <div className="mini-editor" data-testid="mini-editor">
      <div className="mini-edit-col">
        <p className="muted small">
          {!saved?.published ? 'Not published: customers can’t see it yet.' : unpublished || dirty ? 'Live, with changes not published yet.' : `Live since ${new Date(saved.publishedAt!).toLocaleString()}.`}
        </p>
        <fieldset disabled={!canEdit || busy} className="stack">
          <label className="field">
            <span>Name</span>
            <input name="miniName" value={p.name} maxLength={60} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Tagline</span>
            <input name="miniTagline" value={p.tagline} maxLength={120} onChange={(e) => setP({ ...p, tagline: e.target.value })} />
          </label>
          <div className="mini-row">
            <label className="field">
              <span>Icon (one emoji)</span>
              <input name="miniIcon" value={p.icon} maxLength={16} onChange={(e) => setP({ ...p, icon: e.target.value })} />
            </label>
            <label className="field">
              <span>Colour</span>
              <select name="miniAccent" value={p.accent} onChange={(e) => setP({ ...p, accent: e.target.value as Accent })}>
                {ACCENTS.map((a) => (
                  <option key={a} value={a}>
                    {a[0].toUpperCase() + a.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mini-pages" role="group" aria-label="Pages">
            {p.pages.map((x, i) => (
              <button key={x.id} type="button" className={`btn small ${x.id === page.id ? '' : 'quiet'}`} aria-pressed={x.id === page.id} onClick={() => setPageIdx(i)}>
                {x.title}
              </button>
            ))}
            {p.pages.length < 10 && (
              <button
                type="button"
                className="btn quiet small"
                data-testid="add-page"
                onClick={() => {
                  let n = p.pages.length + 1;
                  while (p.pages.some((x) => x.id === `page-${n}`)) n++;
                  setP({ ...p, pages: [...p.pages, { id: `page-${n}`, title: `Page ${n}`, blocks: [] }] });
                  setPageIdx(p.pages.length);
                }}
              >
                + Page
              </button>
            )}
          </div>
          <div className="mini-row">
            <label className="field">
              <span>Page title</span>
              <input name="pageTitle" value={page.title} maxLength={40} onChange={(e) => setPage(page.blocks, { title: e.target.value })} />
            </label>
            {page.id !== p.pages[0].id && (
              <button
                type="button"
                className="btn quiet small danger"
                onClick={() => {
                  // Buttons that went to this page now go to the first page.
                  const home = p.pages[0].id;
                  const fix = (blk: Block): Block => (blk.type === 'button' && blk.action.type === 'page' && blk.action.pageId === page.id ? { ...blk, action: { type: 'page', pageId: home } } : blk);
                  setP({ ...p, pages: p.pages.filter((x) => x.id !== page.id).map((x) => ({ ...x, blocks: x.blocks.map(fix) })) });
                  setPageIdx(0);
                }}
              >
                Delete page
              </button>
            )}
          </div>

          <ol className="mini-blocks">
            {page.blocks.map((blk, i) => (
              <li key={i} className="card mini-block" data-testid="mini-block">
                <div className="mini-row">
                  <strong className="small">{BLOCK_LABELS[blk.type]}</strong>
                  <span>
                    <button type="button" className="link-btn small" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>{' '}
                    <button type="button" className="link-btn small" aria-label="Move down" disabled={i === page.blocks.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>{' '}
                    <button type="button" className="link-btn small" onClick={() => setPage(page.blocks.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </span>
                </div>
                <BlockFields block={blk} pages={p.pages.map((x) => ({ id: x.id, title: x.title }))} onChange={(nb) => setBlock(i, nb)} />
              </li>
            ))}
          </ol>
          {page.blocks.length < 40 && (
            <label className="field">
              <span>Add a block</span>
              <select
                name="addBlock"
                value=""
                onChange={(e) => {
                  const t = e.target.value as Block['type'];
                  if (t) setPage([...page.blocks, BLANK[t]()]);
                }}
              >
                <option value="">Choose…</option>
                {(Object.keys(BLOCK_LABELS) as Block['type'][]).map((t) => (
                  <option key={t} value={t}>
                    {BLOCK_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {canEdit && (
          <div className="extras-actions">
            <button type="button" className="btn quiet" data-testid="mini-save" disabled={busy || !dirty} onClick={() => run(save, 'Saved. Customers will see it once you publish.')}>
              Save draft
            </button>
            <button
              type="button"
              className="btn"
              data-testid="mini-publish"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (dirty) await save();
                  setSaved(await chatApi<StaffMini>('POST', `businesses/${b.id}/mini-program/publish`));
                }, 'Published. Customers can open it from Apps.')
              }
            >
              Publish
            </button>
            {saved?.published && (
              <button type="button" className="btn quiet small" disabled={busy} onClick={() => run(async () => setSaved(await chatApi<StaffMini>('DELETE', `businesses/${b.id}/mini-program/publish`)), 'Unpublished.')}>
                Unpublish
              </button>
            )}
            {saved?.published && (
              <a className="small" href={`/apps/m/${saved.id}`} data-testid="mini-open-live">
                Open the live one
              </a>
            )}
          </div>
        )}
        {msg && (
          <p className={msg.ok ? 'small' : 'error'} role={msg.ok ? 'status' : 'alert'} data-testid="mini-msg">
            {msg.text}
          </p>
        )}
      </div>
      <div className="mini-preview" aria-label="Preview">
        <p className="muted small">Preview</p>
        <MiniView key={JSON.stringify(p.pages.map((x) => x.id))} program={p} business={b} data={data} preview />
      </div>
    </div>
  );
}

function BlockFields({ block: blk, pages, onChange }: { block: Block; pages: { id: string; title: string }[]; onChange: (b: Block) => void }) {
  switch (blk.type) {
    case 'heading':
      return <input aria-label="Heading text" value={blk.text} maxLength={120} onChange={(e) => onChange({ ...blk, text: e.target.value })} />;
    case 'text':
      return <textarea aria-label="Text" value={blk.text} maxLength={2000} rows={3} onChange={(e) => onChange({ ...blk, text: e.target.value })} />;
    case 'items':
      return <input aria-label="Menu title (optional)" placeholder="Title (optional)" value={blk.title} maxLength={60} onChange={(e) => onChange({ ...blk, title: e.target.value })} />;
    case 'location':
      return (
        <div className="mini-row">
          <input aria-label="Place name" placeholder="Place name" value={blk.label} maxLength={120} onChange={(e) => onChange({ ...blk, label: e.target.value })} />
          <input aria-label="Latitude" type="number" step="0.000001" min={-90} max={90} value={blk.lat} onChange={(e) => onChange({ ...blk, lat: Number(e.target.value) })} />
          <input aria-label="Longitude" type="number" step="0.000001" min={-180} max={180} value={blk.lng} onChange={(e) => onChange({ ...blk, lng: Number(e.target.value) })} />
        </div>
      );
    case 'button': {
      const a = blk.action;
      const setAction = (action: Action) => onChange({ ...blk, action });
      return (
        <div className="stack">
          <input aria-label="Button label" value={blk.label} maxLength={40} onChange={(e) => onChange({ ...blk, label: e.target.value })} />
          <select
            aria-label="What the button does"
            value={a.type}
            onChange={(e) => {
              const t = e.target.value as Action['type'];
              setAction(t === 'page' ? { type: 'page', pageId: pages[0].id } : t === 'link' ? { type: 'link', url: 'https://' } : { type: t });
            }}
          >
            {(Object.keys(ACTION_LABELS) as Action['type'][]).map((t) => (
              <option key={t} value={t}>
                {ACTION_LABELS[t]}
              </option>
            ))}
          </select>
          {a.type === 'page' && (
            <select aria-label="Which page" value={a.pageId} onChange={(e) => setAction({ type: 'page', pageId: e.target.value })}>
              {pages.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          )}
          {a.type === 'link' && <input aria-label="Website address" type="url" value={a.url} maxLength={500} onChange={(e) => setAction({ type: 'link', url: e.target.value })} />}
        </div>
      );
    }
    default:
      return <p className="muted small">{blk.type === 'hours' ? 'Shows the opening hours you set under Services and hours.' : 'A line between blocks.'}</p>;
  }
}
