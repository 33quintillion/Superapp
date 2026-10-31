'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { encodeQr } from '@/lib/qr';
import { pollLink, startLink } from './actions';
import styles from './auth.module.css';

/** What the phone app looks for in a scanned code. */
export const LINK_PREFIX = 'SUPERAPP-LINK:';
/** After this many codes expire unscanned, wait for a click rather than asking forever. */
const AUTO_REFRESHES = 4;
/** Asking again every 4 seconds, 25 times, covers the server waking from sleep. */
const WAKE_ATTEMPTS = 25;
const WAKE_DELAY_MS = 4000;

function QrSvg({ text }: { text: string }) {
  const modules = useMemo(() => encodeQr(text), [text]);
  const n = modules.length + 8; // four modules of quiet zone on each side
  let d = '';
  modules.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className={styles.qr} role="img" aria-label="QR code to link this browser" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#14181f" />
    </svg>
  );
}

/**
 * Shows a code to scan with the phone app, as WhatsApp Web does, and waits for the phone to
 * approve it. Codes last two minutes and are replaced as they run out.
 */
export function LinkQr() {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [linked, setLinked] = useState(false);
  const refreshes = useRef(0);

  const [waking, setWaking] = useState(false);
  const unmounted = useRef(false);

  // Asks for a code. While the server is waking up (up to a minute on the free hosting plan)
  // it keeps asking quietly, then offers a button rather than spinning forever.
  const fresh = async () => {
    setStale(false);
    setError(null);
    setCode(null);
    for (let attempt = 0; ; attempt++) {
      let r: Awaited<ReturnType<typeof startLink>>;
      try {
        r = await startLink();
      } catch {
        r = { error: 'Couldn’t make a code.', retry: true };
      }
      if (unmounted.current) return;
      if (r.code) {
        setWaking(false);
        setCode(r.code);
        return;
      }
      if (!r.retry || attempt >= WAKE_ATTEMPTS) {
        setWaking(false);
        setError(r.error ?? 'Couldn’t make a code.');
        return;
      }
      setWaking(true);
      await new Promise((done) => setTimeout(done, WAKE_DELAY_MS));
      if (unmounted.current) return;
    }
  };

  useEffect(() => {
    void fresh();
    return () => {
      unmounted.current = true;
    };
  }, []);

  useEffect(() => {
    if (!code || stale) return;
    let stopped = false;
    const tick = async () => {
      const r = await pollLink();
      if (stopped) return;
      if (r.status === 'linked') {
        setLinked(true);
        router.push(r.next!);
      } else if (r.status === 'expired') {
        if (refreshes.current++ < AUTO_REFRESHES) void fresh();
        else setStale(true);
      } else {
        timer = setTimeout(tick, 3000);
      }
    };
    let timer = setTimeout(tick, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code, stale]);

  return (
    <div data-testid="link-qr">
      <h2 className={styles.title}>Scan to log in</h2>
      <p className={styles.lede}>Use the SuperApp app on a phone where you’re already signed in.</p>
      <div className={styles.qrFrame}>
        {code && !stale && !linked && <QrSvg text={`${LINK_PREFIX}${code}`} />}
        {(stale || error) && (
          <button
            type="button"
            className={styles.qrReload}
            onClick={() => {
              refreshes.current = 0;
              void fresh();
            }}
          >
            {error ?? 'This code ran out.'} Click to try again.
          </button>
        )}
        {!code && !stale && !error && (
          <span className={styles.qrWait} role="status">
            {waking ? 'Waking up SuperApp… this can take up to a minute.' : 'Making a code…'}
          </span>
        )}
        {linked && <span className={styles.qrWait}>Linked. Opening SuperApp…</span>}
      </div>
      {code && !stale && !linked && (
        <p className={styles.fine}>
          Can’t scan? In the app, type <strong className={styles.typedCode}>{`${code.slice(0, 4)}-${code.slice(4)}`}</strong> instead.
        </p>
      )}
    </div>
  );
}
