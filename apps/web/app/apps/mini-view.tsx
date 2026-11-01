'use client';

import { useState } from 'react';
import { type Business, type Item, money } from '@/lib/business-client';
import type { Block, MiniProgram } from '@/lib/mini-client';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface MiniData {
  items: Item[];
  hours: { weekday: number; opens: string; closes: string }[];
}

/**
 * A mini-program on screen: its pages and blocks, drawn by SuperApp itself (no code from the
 * business runs). Order and Book open the business's own order and booking screens; Call uses
 * its listed number; website links say they leave SuperApp.
 */
export function MiniView({ program, business, data, preview = false }: { program: MiniProgram; business: Pick<Business, 'handle' | 'name' | 'phone' | 'ordersEnabled' | 'bookingsEnabled' | 'currency'>; data: MiniData; preview?: boolean }) {
  const [pageId, setPageId] = useState(program.pages[0]?.id);
  const page = program.pages.find((p) => p.id === pageId) ?? program.pages[0];
  if (!page) return null;
  const isHome = page.id === program.pages[0].id;
  return (
    <article className={`mini accent-${program.accent}`} data-testid="mini-view">
      <header className="mini-head">
        {!isHome && (
          <button type="button" className="mini-back" aria-label="Back to the first page" onClick={() => setPageId(program.pages[0].id)}>
            ←
          </button>
        )}
        <span className="mini-icon" aria-hidden="true">
          {program.icon}
        </span>
        <span>
          <strong className="mini-name">{program.name}</strong>
          {isHome && program.tagline && <span className="mini-tagline">{program.tagline}</span>}
          {!isHome && <span className="mini-tagline">{page.title}</span>}
        </span>
      </header>
      <div className="mini-body">
        {page.blocks.map((b, i) => (
          <MiniBlock key={i} block={b} business={business} data={data} preview={preview} go={setPageId} />
        ))}
        {page.blocks.length === 0 && <p className="muted small">This page is empty.</p>}
      </div>
      <footer className="mini-foot small muted">
        A mini-program by {business.name} · inside SuperApp
      </footer>
    </article>
  );
}

function MiniBlock({ block: b, business, data, preview, go }: { block: Block; business: Parameters<typeof MiniView>[0]['business']; data: MiniData; preview: boolean; go: (id: string) => void }) {
  switch (b.type) {
    case 'heading':
      return <h2 className="mini-h">{b.text}</h2>;
    case 'text':
      return <p className="mini-text">{b.text}</p>;
    case 'divider':
      return <hr className="mini-hr" />;
    case 'items':
      return (
        <section className="mini-items" data-testid="mini-items">
          {b.title && <h3>{b.title}</h3>}
          {data.items.length === 0 ? (
            <p className="muted small">Nothing on the menu right now.</p>
          ) : (
            <ul>
              {data.items.map((it) => (
                <li key={it.id}>
                  <span>
                    <strong>{it.name}</strong>
                    {it.description && <span className="muted small"> · {it.description}</span>}
                  </span>
                  <span className="mini-price">{money(it.priceMinor, business.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    case 'hours':
      return (
        <section className="mini-hours" data-testid="mini-hours">
          <h3>Opening hours</h3>
          {data.hours.length === 0 ? (
            <p className="muted small">Not listed.</p>
          ) : (
            <dl>
              {DAYS.map((d, wd) => {
                const slots = data.hours.filter((h) => h.weekday === wd);
                return (
                  <div key={d}>
                    <dt>{d}</dt>
                    <dd>{slots.length ? slots.map((s) => `${s.opens}–${s.closes}`).join(', ') : 'Closed'}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </section>
      );
    case 'location': {
      const href = `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=17/${b.lat}/${b.lng}`;
      return (
        <a className="mini-location" href={href} target="_blank" rel="noopener noreferrer">
          📍 <strong>{b.label || 'Find us'}</strong> <span className="muted small">Open map</span>
        </a>
      );
    }
    case 'button': {
      const a = b.action;
      const cls = 'btn mini-btn';
      if (a.type === 'page') {
        return (
          <button type="button" className={cls} onClick={() => go(a.pageId)}>
            {b.label}
          </button>
        );
      }
      if (preview) {
        return (
          <button type="button" className={cls} disabled title="Works once published">
            {b.label}
          </button>
        );
      }
      if (a.type === 'order' || a.type === 'book') {
        const on = a.type === 'order' ? business.ordersEnabled : business.bookingsEnabled;
        return on ? (
          <a className={cls} href={`/b/${business.handle}`}>
            {b.label}
          </a>
        ) : (
          <button type="button" className={cls} disabled title={a.type === 'order' ? 'Not taking orders right now' : 'Not taking bookings right now'}>
            {b.label}
          </button>
        );
      }
      if (a.type === 'call') {
        return business.phone ? (
          <a className={cls} href={`tel:${business.phone}`}>
            {b.label}
          </a>
        ) : null;
      }
      return (
        <a className={cls} href={a.url} target="_blank" rel="noopener noreferrer nofollow">
          {b.label} <span className="sr-only">(opens a website outside SuperApp)</span> ↗
        </a>
      );
    }
  }
}
