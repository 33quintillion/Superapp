'use client';

import { useCallback, useEffect, useState } from 'react';
import { chatApi } from '@/lib/chat-client';

interface Settings {
  pushEnabled: boolean;
  preview: 'full' | 'sender' | 'none';
  quietHours: { start: string; end: string; timeZone: string } | null;
}
interface PushConfig {
  providers: { apns: boolean; fcm: boolean; webpush: boolean };
  vapidPublicKey: string | null;
}
interface Device {
  id: string;
  provider: string;
  current: boolean;
  deliverable: boolean;
  disabledReason: string | null;
}

type BrowserState = 'loading' | 'unsupported' | 'not-configured' | 'blocked' | 'off' | 'on' | 'broken';

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Notification preferences, plus turning notifications on for this browser. */
export function NotificationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [quiet, setQuiet] = useState({ on: false, start: '22:00', end: '07:00' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserState>('loading');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refreshBrowser = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setBrowser('unsupported');
    const [config, devices] = await Promise.all([chatApi<PushConfig>('GET', 'push/config'), chatApi<Device[]>('GET', 'push/devices')]);
    if (!config.vapidPublicKey) return setBrowser('not-configured');
    if (Notification.permission === 'denied') return setBrowser('blocked');
    const mine = devices.find((d) => d.current);
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (mine && sub) setBrowser(mine.deliverable ? 'on' : 'broken');
    else setBrowser('off');
  }, []);

  useEffect(() => {
    chatApi<Settings>('GET', 'me/notifications')
      .then((s) => {
        setSettings(s);
        if (s.quietHours) setQuiet({ on: true, start: s.quietHours.start, end: s.quietHours.end });
      })
      .catch((e) => setError(e.message));
    refreshBrowser().catch(() => setBrowser('unsupported'));
  }, [refreshBrowser]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError(null);
    setSaved(false);
    try {
      const next = await chatApi<Settings>('PATCH', 'me/notifications', {
        pushEnabled: settings.pushEnabled,
        preview: settings.preview,
        quietHours: quiet.on ? { start: quiet.start, end: quiet.end, timeZone: localZone() } : null,
      });
      setSettings(next);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function turnOn() {
    setBusy(true);
    setNote(null);
    try {
      const config = await chatApi<PushConfig>('GET', 'push/config');
      if (!config.vapidPublicKey) return setBrowser('not-configured');
      if ((await Notification.requestPermission()) !== 'granted') return setBrowser(Notification.permission === 'denied' ? 'blocked' : 'off');
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      // A subscription made with an old server key can't be used; start over.
      if (existing && keyOf(existing) !== config.vapidPublicKey) await existing.unsubscribe();
      const sub =
        (existing && keyOf(existing) === config.vapidPublicKey ? existing : null) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(config.vapidPublicKey) }));
      const json = sub.toJSON();
      await chatApi('PUT', 'push/devices/current', { provider: 'webpush', endpoint: json.endpoint, keys: json.keys });
      await refreshBrowser();
    } catch (err) {
      setNote(`Couldn't turn on notifications: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      await chatApi('DELETE', 'push/devices/current');
      await refreshBrowser();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setNote(null);
    try {
      await chatApi('POST', 'push/devices/current/test');
      setNote('Test sent. It should appear in a few seconds.');
    } catch (err) {
      setNote((err as Error).message);
    }
  }

  return (
    <div className="card" data-testid="notifications">
      <div className="row">
        <div>
          <div>This browser</div>
          <small className="muted" data-testid="browser-push-state">
            {
              {
                loading: 'Checking…',
                unsupported: 'This browser can’t show notifications.',
                'not-configured': 'Browser notifications aren’t set up on this server yet.',
                blocked: 'Notifications are blocked in your browser’s site settings.',
                off: 'Off',
                on: 'On',
                broken: 'Stopped working. Turn it on again.',
              }[browser]
            }
          </small>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          {(browser === 'off' || browser === 'broken') && (
            <button className="btn small" type="button" onClick={turnOn} disabled={busy}>
              Turn on
            </button>
          )}
          {browser === 'on' && (
            <>
              <button className="btn quiet small" type="button" onClick={test}>
                Send a test
              </button>
              <button className="btn quiet small" type="button" onClick={turnOff} disabled={busy}>
                Turn off
              </button>
            </>
          )}
        </div>
      </div>
      {note && <p className="muted">{note}</p>}

      {settings && (
        <form onSubmit={save} className="stack" style={{ marginTop: 'var(--space-md)' }}>
          <label className="row">
            <span>Notifications on all devices</span>
            <input
              type="checkbox"
              name="pushEnabled"
              checked={settings.pushEnabled}
              onChange={(e) => setSettings({ ...settings, pushEnabled: e.target.checked })}
            />
          </label>
          <label className="field">
            <span>Show in notifications</span>
            <select name="preview" value={settings.preview} onChange={(e) => setSettings({ ...settings, preview: e.target.value as Settings['preview'] })}>
              <option value="full">Sender and message</option>
              <option value="sender">Sender only</option>
              <option value="none">Nothing (just “New message”)</option>
            </select>
            <small>Message text passes through Apple’s, Google’s or your browser’s push service when shown.</small>
          </label>
          <label className="row">
            <span>Quiet hours (no sound)</span>
            <input type="checkbox" name="quiet" checked={quiet.on} onChange={(e) => setQuiet({ ...quiet, on: e.target.checked })} />
          </label>
          {quiet.on && (
            <div className="row">
              <label className="field">
                <span>From</span>
                <input type="time" name="quietStart" value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} required />
              </label>
              <label className="field">
                <span>Until</span>
                <input type="time" name="quietEnd" value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} required />
              </label>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <div>
            <button className="btn" type="submit">
              Save
            </button>{' '}
            {saved && (
              <span className="muted" data-testid="notifications-saved">
                Saved
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function keyOf(sub: PushSubscription): string | null {
  const key = sub.options.applicationServerKey;
  if (!key) return null;
  return btoa(String.fromCharCode(...new Uint8Array(key)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
