'use client';

import { useState } from 'react';
import { chatApi } from '@/lib/chat-client';
import type { Integration } from '@/lib/business-client';

/** Partner integrations reviewed by SuperApp. Connecting one grants only the boxes ticked. */
export function AppsCatalogue({ catalogue: initial, connected: initialConnected }: { catalogue: Integration[]; connected: Integration[] }) {
  const [catalogue, setCatalogue] = useState(initial);
  const [connected, setConnected] = useState(initialConnected);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = async () => {
    setCatalogue((await chatApi<{ integrations: Integration[] }>('GET', 'integrations')).integrations);
    setConnected((await chatApi<{ integrations: Integration[] }>('GET', 'me/integrations')).integrations);
  };
  return (
    <main className="wide social">
      <h1>Apps and services</h1>
      <p className="muted">
        Services from partners that SuperApp has reviewed. They never see your messages or contacts, and you choose what each one can use. Partners can’t use these
        connections yet; that starts when the first partner goes live.
      </p>
      {err && <p className="error">{err}</p>}

      <h2>Connected</h2>
      <div className="card">
        {connected.length === 0 && <p className="muted">Nothing connected.</p>}
        {connected.map((i) => (
          <div className="row" key={i.id} data-testid="connected-app">
            <span>
              <strong>{i.name}</strong> {!i.grant?.active && <span className="pill">Paused by SuperApp</span>}
              <br />
              <span className="small muted">Can use: {i.grant?.scopes.length ? i.scopes.filter((s) => i.grant!.scopes.includes(s.scope)).map((s) => s.description).join('; ') : 'nothing'}</span>
            </span>
            <button
              className="btn quiet small danger"
              onClick={async () => {
                await chatApi('DELETE', `integrations/${i.slug}/connection`);
                await reload();
              }}
            >
              Disconnect
            </button>
          </div>
        ))}
      </div>

      <h2>Available</h2>
      <div className="card">
        {catalogue.length === 0 && <p className="muted">No partner services yet.</p>}
        {catalogue.map((i) => (
          <div key={i.id} className="stack" style={{ padding: 'var(--space-md) 0' }} data-testid="catalogue-app">
            <div className="row">
              <span>
                <strong>{i.name}</strong> <span className="muted small">by {i.developer.name}</span> <span className="pill">{i.category}</span>
                {i.description && (
                  <>
                    <br />
                    <span className="small">{i.description}</span>
                  </>
                )}
              </span>
              <button className="btn small" onClick={() => setOpen(open === i.id ? null : i.id)}>
                {i.grant ? 'Change' : 'Connect'}
              </button>
            </div>
            {open === i.id && (
              <form
                className="stack"
                data-testid="consent"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setErr(null);
                  const f = new FormData(e.currentTarget);
                  try {
                    await chatApi('PUT', `integrations/${i.slug}/connection`, { scopes: f.getAll('scope') });
                    setOpen(null);
                    await reload();
                  } catch (x) {
                    setErr(x instanceof Error ? x.message : 'Could not connect');
                  }
                }}
              >
                <p className="small">{i.name} asks to use:</p>
                {i.scopes.map((s) => (
                  <label key={s.scope} className="composer-row small">
                    <input type="checkbox" name="scope" value={s.scope} defaultChecked={i.grant ? i.grant.scopes.includes(s.scope) : true} /> {s.description}
                  </label>
                ))}
                <p className="small muted">
                  You can disconnect at any time. <a href={i.homepageUrl} target="_blank" rel="noopener noreferrer">About {i.name}</a>
                </p>
                <button className="btn small" type="submit">
                  Allow
                </button>
              </form>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
