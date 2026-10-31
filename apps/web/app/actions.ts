'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError, TokenPair } from '@/lib/api';
import { cookieOpts, MFA_COOKIE, PHONE_SIGNUP_COOKIE } from '@/lib/cookies';
import { authed, clearTokens, requireAccessToken, storeTokens } from '@/lib/session';

export interface FormState {
  error?: string;
  done?: boolean;
  /** Non-secret fields echoed back so the form keeps them after an error. */
  values?: Record<string, string>;
}

const SECRET_FIELDS = new Set(['password', 'newPassword', 'confirm', 'code', 'token']);
const keep = (f: FormData) =>
  Object.fromEntries([...f.entries()].filter(([k, v]) => !SECRET_FIELDS.has(k) && typeof v === 'string' && !k.startsWith('$')) as [string, string][]);

const field = (f: FormData, k: string) => String(f.get(k) ?? '');

/** Converts API errors into a message for the form; anything else is a real bug and is rethrown. */
async function attempt(f: FormData, fn: () => Promise<void>): Promise<FormState> {
  try {
    await fn();
    return { done: true };
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message, values: keep(f) };
    throw e;
  }
}

export async function signIn(_: FormState, f: FormData): Promise<FormState> {
  let next = '/account';
  const res = await attempt(f, async () => {
    const r = await api<TokenPair | { mfaRequired: true; mfaToken: string }>('POST', '/v1/auth/login', {
      body: { email: field(f, 'email'), password: field(f, 'password'), deviceName: 'Web browser' },
    });
    if ('mfaRequired' in r) {
      (await cookies()).set(MFA_COOKIE, r.mfaToken, cookieOpts(300));
      next = '/sign-in/mfa';
    } else {
      await storeTokens(r);
    }
  });
  if (res.error) return res;
  redirect(next);
}

export async function submitMfa(_: FormState, f: FormData): Promise<FormState> {
  const mfaToken = (await cookies()).get(MFA_COOKIE)?.value;
  if (!mfaToken) return { error: 'Your sign-in attempt expired. Please start again.' };
  const res = await attempt(f, async () => {
    await storeTokens(await api<TokenPair>('POST', '/v1/auth/login/mfa', { body: { mfaToken, code: field(f, 'code'), deviceName: 'Web browser' } }));
  });
  if (res.error) return res;
  redirect('/account');
}

export async function register(_: FormState, f: FormData): Promise<FormState> {
  const res = await attempt(f, async () => {
    await storeTokens(
      await api<TokenPair>('POST', '/v1/auth/register', {
        body: {
          email: field(f, 'email'),
          password: field(f, 'password'),
          username: field(f, 'username'),
          displayName: field(f, 'displayName'),
          deviceName: 'Web browser',
        },
      }),
    );
  });
  if (res.error) return res;
  redirect('/account');
}

type PhoneOutcome = TokenPair | { mfaRequired: true; mfaToken: string } | { signupRequired: true; signupToken: string; phone: string };

/**
 * Called from the phone sign-in form once Firebase has checked the code. The API verifies
 * the ID token; we keep the resulting tokens (or the next step's token) in httpOnly cookies.
 */
export async function phoneSignIn(idToken: string): Promise<{ next?: string; error?: string }> {
  try {
    const r = await api<PhoneOutcome>('POST', '/v1/auth/phone', { body: { idToken, deviceName: 'Web browser' } });
    const jar = await cookies();
    if ('signupRequired' in r) {
      jar.set(PHONE_SIGNUP_COOKIE, r.signupToken, cookieOpts(15 * 60));
      return { next: '/sign-in/name' };
    }
    if ('mfaRequired' in r) {
      jar.set(MFA_COOKIE, r.mfaToken, cookieOpts(300));
      return { next: '/sign-in/mfa' };
    }
    await storeTokens(r);
    return { next: '/account' };
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
}

/** A new phone user's name (and optional username), which creates the account. */
export async function completePhoneSignUp(_: FormState, f: FormData): Promise<FormState> {
  const jar = await cookies();
  const signupToken = jar.get(PHONE_SIGNUP_COOKIE)?.value;
  if (!signupToken) return { error: 'Your sign-up expired. Please enter your number again.' };
  const username = field(f, 'username').trim().toLowerCase();
  const res = await attempt(f, async () => {
    await storeTokens(
      await api<TokenPair>('POST', '/v1/auth/phone/complete', {
        body: { signupToken, displayName: field(f, 'displayName'), ...(username ? { username } : {}), deviceName: 'Web browser' },
      }),
    );
    jar.delete(PHONE_SIGNUP_COOKIE);
  });
  if (res.error) return res;
  redirect('/account');
}

/** Adds or changes the optional email (receipts, banking and payouts). */
export async function setEmail(_: FormState, f: FormData): Promise<FormState> {
  const res = await attempt(f, () => authed('PUT', '/v1/me/email', { email: field(f, 'email') }));
  if (!res.error) revalidatePath('/account');
  return res;
}

export async function removeEmail() {
  await authed('DELETE', '/v1/me/email');
  revalidatePath('/account');
}

export async function forgotPassword(_: FormState, f: FormData): Promise<FormState> {
  return attempt(f, () => api('POST', '/v1/auth/password/forgot', { body: { email: field(f, 'email') } }));
}

export async function resetPassword(_: FormState, f: FormData): Promise<FormState> {
  if (field(f, 'newPassword') !== field(f, 'confirm')) return { error: 'The passwords do not match.' };
  return attempt(f, () => api('POST', '/v1/auth/password/reset', { body: { token: field(f, 'token'), newPassword: field(f, 'newPassword') } }));
}

export async function signOut() {
  try {
    await api('POST', '/v1/auth/logout', { accessToken: await requireAccessToken() });
  } catch {
    // Local sign-out still happens below.
  }
  await clearTokens();
  redirect('/sign-in');
}

export async function revokeSession(f: FormData) {
  await authed('DELETE', `/v1/sessions/${encodeURIComponent(field(f, 'id'))}`);
  revalidatePath('/account');
}

export async function resendVerification() {
  await authed('POST', '/v1/auth/verify-email/resend');
}
