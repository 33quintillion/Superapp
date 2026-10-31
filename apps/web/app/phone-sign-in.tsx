'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { phoneSignIn } from './actions';
import styles from './auth.module.css';

interface Config {
  apiKey: string;
  authBase: string;
  countryCode: string;
}

type Grecaptcha = {
  ready: (cb: () => void) => void;
  render: (el: HTMLElement, opts: { sitekey: string; size: 'invisible'; callback: (token: string) => void; 'error-callback'?: () => void }) => number;
  execute: (id: number) => void;
  reset: (id: number) => void;
};

const FIREBASE_ERRORS: Record<string, string> = {
  INVALID_PHONE_NUMBER: 'That phone number doesn’t look right.',
  MISSING_PHONE_NUMBER: 'Enter your phone number.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a while and try again.',
  QUOTA_EXCEEDED: 'We can’t send codes right now. Try again later.',
  CAPTCHA_CHECK_FAILED: 'The robot check didn’t pass. Try again.',
  INVALID_CODE: 'That code is wrong. Check the text message and try again.',
  INVALID_SESSION_INFO: 'That code has expired. Ask for a new one.',
  SESSION_EXPIRED: 'That code has expired. Ask for a new one.',
  CODE_EXPIRED: 'That code has expired. Ask for a new one.',
};

class FirebaseError extends Error {}

/** Turns what people type (spaces, a leading 0, no country code) into E.164. */
export function toE164(input: string, countryCode: string): string {
  const raw = input.replace(/[\s\-().]/g, '');
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return `+${raw.slice(2)}`;
  return `${countryCode}${raw.replace(/^0+/, '')}`;
}

/**
 * Phone sign-in and sign-up in one: Firebase texts a code (after an invisible reCAPTCHA),
 * and the signed ID token it returns for the right code goes to our server, which checks
 * it with the API. The browser talks to Firebase directly, so no SDK is bundled.
 */
/** Groups an Indian number as people write it: 98765 43210. Other input is left alone. */
function groupDigits(raw: string) {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  return d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d;
}

const RESEND_AFTER_S = 30;

/**
 * Phone sign-in and sign-up in one: Firebase texts a code (after an invisible reCAPTCHA),
 * and the signed ID token it returns for the right code goes to our server, which checks
 * it with the API. The browser talks to Firebase directly, so no SDK is bundled.
 */
export function PhoneSignIn({ config }: { config: Config }) {
  const router = useRouter();
  const [step, setStep] = useState<'number' | 'code'>('number');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const sessionInfo = useRef<string | null>(null);
  const captchaBox = useRef<HTMLDivElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const india = config.countryCode === '+91';
  const number = toE164(phone.startsWith('+') ? phone : `${config.countryCode}${phone.replace(/\D/g, '')}`, config.countryCode);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  useEffect(() => {
    if (step === 'code') codeInput.current?.focus();
  }, [step]);

  const call = async <T,>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${config.authBase}/v1/${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.apiKey)}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = String(json?.error?.message ?? '').split(/[ :]/)[0];
      throw new FirebaseError(FIREBASE_ERRORS[reason] ?? 'Something went wrong. Try again.');
    }
    return json as T;
  };

  /** An invisible reCAPTCHA token, which Firebase asks for before it sends a text. */
  const recaptchaToken = async (): Promise<string | undefined> => {
    const { recaptchaSiteKey } = await call<{ recaptchaSiteKey?: string }>('recaptchaParams');
    if (!recaptchaSiteKey) return undefined;
    const w = window as unknown as { grecaptcha?: Grecaptcha };
    if (!w.grecaptcha) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new FirebaseError('Couldn’t load the robot check. Check your connection.'));
        document.head.appendChild(s);
      });
    }
    const g = w.grecaptcha!;
    await new Promise<void>((r) => g.ready(r));
    const box = document.createElement('div');
    captchaBox.current!.replaceChildren(box);
    return new Promise((resolve, reject) => {
      const id = g.render(box, { sitekey: recaptchaSiteKey, size: 'invisible', callback: resolve, 'error-callback': () => reject(new FirebaseError(FIREBASE_ERRORS.CAPTCHA_CHECK_FAILED)) });
      g.execute(id);
    });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof FirebaseError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      if (!/^\+[1-9][0-9]{6,14}$/.test(number) || (india && !phone.startsWith('+') && phone.replace(/\D/g, '').length !== 10)) {
        throw new FirebaseError(FIREBASE_ERRORS.INVALID_PHONE_NUMBER);
      }
      const r = await call<{ sessionInfo: string }>('accounts:sendVerificationCode', { phoneNumber: number, recaptchaToken: await recaptchaToken() });
      sessionInfo.current = r.sessionInfo;
      setCode('');
      setWait(RESEND_AFTER_S);
      setStep('code');
    });

  const checkCode = (value = code) =>
    run(async () => {
      if (value.length !== 6) throw new FirebaseError('Enter all 6 digits.');
      const r = await call<{ idToken: string }>('accounts:signInWithPhoneNumber', { sessionInfo: sessionInfo.current, code: value });
      const outcome = await phoneSignIn(r.idToken);
      if (outcome.error) throw new FirebaseError(outcome.error);
      router.push(outcome.next!);
    });

  const shown = phone.startsWith('+') ? number : `${config.countryCode} ${groupDigits(phone)}`;

  return (
    <form
      data-testid="phone-sign-in"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void (step === 'number' ? sendCode() : checkCode());
      }}
    >
      {step === 'number' ? (
        <>
          <h1 className={styles.title}>Your phone number</h1>
          <p className={styles.lede}>We’ll text you a code. New to SuperApp? Your account is set up when you confirm it.</p>
          <label htmlFor="phone" className="sr-only">
            Phone number
          </label>
          <div className={styles.phoneRow}>
            <span className={styles.country} aria-hidden="true">
              {india && <span className={styles.countryCode}>IN</span>}
              {config.countryCode}
            </span>
            <input
              id="phone"
              name="phone"
              className={styles.phoneInput}
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder={india ? '98765 43210' : 'Phone number'}
              value={phone.startsWith('+') ? phone : groupDigits(phone)}
              onChange={(e) => {
                const v = e.target.value;
                // A pasted number with its country code is kept whole; anything else is digits.
                setPhone(v.trim().startsWith('+') ? v.trim() : v.replace(/\D/g, '').replace(/^0+/, '').slice(0, india ? 10 : 15));
              }}
              aria-describedby="phone-help"
              required
            />
          </div>
          <p id="phone-help" className={styles.fine}>
            Another country? Type + and its code first. Standard SMS rates may apply.
          </p>
        </>
      ) : (
        <>
          <h1 className={styles.title}>Enter the code</h1>
          <p className={styles.sentTo}>
            Sent by SMS to <strong>{shown}</strong>
            <button type="button" className="link-btn" onClick={() => { setStep('number'); setError(null); }}>
              Change number
            </button>
          </p>
          <label htmlFor="code" className="sr-only">
            6-digit code
          </label>
          <div className={styles.code} onClick={() => codeInput.current?.focus()}>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={`${styles.box} ${code[i] ? styles.filled : ''} ${i === Math.min(code.length, 5) ? styles.active : ''}`} aria-hidden="true">
                {code[i] ?? ''}
              </span>
            ))}
            <input
              ref={codeInput}
              id="code"
              name="code"
              className={styles.codeInput}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(v);
                // The sixth digit (typed, pasted or filled in from the SMS) checks the code at once.
                if (v.length === 6 && !busy) void checkCode(v);
              }}
              required
            />
          </div>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={styles.primary} disabled={busy}>
        {busy ? (step === 'number' ? 'Sending code…' : 'Checking…') : step === 'number' ? 'Send code' : 'Continue'}
      </button>
      {step === 'code' && (
        <div className={styles.after}>
          <span>Didn’t get it?</span>
          {wait > 0 ? (
            <span className={styles.countdown} aria-live="polite">
              New code in 0:{String(wait).padStart(2, '0')}
            </span>
          ) : (
            <button type="button" className="link-btn" disabled={busy} onClick={() => void sendCode()}>
              Send a new code
            </button>
          )}
        </div>
      )}
      <div ref={captchaBox} />
    </form>
  );
}
