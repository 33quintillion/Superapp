'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError, TokenPair } from '@/lib/api';
import { cookieOpts, MFA_COOKIE } from '@/lib/cookies';
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
