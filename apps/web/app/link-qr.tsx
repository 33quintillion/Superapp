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

  const fresh = async () => {
    setStale(false);
    setCode(null);
    const r = await startLink();
    if (r.error || !r.code) return setError(r.error ?? 'Couldn’t make a code. Try again.');
    setError(null);
    setCode(r.code);
  };

  useEffect(() => {
    void fresh();
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
            {error ?? 'This code ran out.'} Click to get a new one.
          </button>
        )}
        {!code && !stale && !error && <span className={styles.qrWait}>Making a code…</span>}
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
