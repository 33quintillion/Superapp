'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { phoneSignIn } from './actions';

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
export function PhoneSignIn({ config }: { config: Config }) {
  const router = useRouter();
  const [step, setStep] = useState<'number' | 'code'>('number');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionInfo = useRef<string | null>(null);
  const captchaBox = useRef<HTMLDivElement>(null);

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
      const phoneNumber = toE164(phone, config.countryCode);
      if (!/^\+[1-9][0-9]{6,14}$/.test(phoneNumber)) throw new FirebaseError(FIREBASE_ERRORS.INVALID_PHONE_NUMBER);
      const r = await call<{ sessionInfo: string }>('accounts:sendVerificationCode', { phoneNumber, recaptchaToken: await recaptchaToken() });
      sessionInfo.current = r.sessionInfo;
      setCode('');
      setStep('code');
    });

  const checkCode = () =>
    run(async () => {
      const r = await call<{ idToken: string }>('accounts:signInWithPhoneNumber', { sessionInfo: sessionInfo.current, code: code.trim() });
      const outcome = await phoneSignIn(r.idToken);
      if (outcome.error) throw new FirebaseError(outcome.error);
      router.push(outcome.next!);
    });

  return (
    <form
      className="stack"
      data-testid="phone-sign-in"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void (step === 'number' ? sendCode() : checkCode());
      }}
    >
      {step === 'number' ? (
        <label className="field">
          <span>Phone number</span>
          <input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder={`${config.countryCode} 98765 43210`}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <small>We’ll text you a 6-digit code.</small>
        </label>
      ) : (
        <>
          <p className="muted">
            Code sent to {toE164(phone, config.countryCode)}.{' '}
            <button type="button" className="link-btn" onClick={() => setStep('number')}>
              Change number
            </button>
          </p>
          <label className="field">
            <span>Code</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
          </label>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? (step === 'number' ? 'Sending…' : 'Checking…') : step === 'number' ? 'Send code' : 'Continue'}
      </button>
      {step === 'code' && (
        <button type="button" className="btn quiet" disabled={busy} onClick={() => void sendCode()}>
          Send a new code
        </button>
      )}
      <div ref={captchaBox} />
    </form>
  );
}
