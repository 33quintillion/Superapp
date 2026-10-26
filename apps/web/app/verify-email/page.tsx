import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let ok = false;
  let message = 'This link is incomplete.';
  if (token) {
    try {
      await api('POST', '/v1/auth/verify-email', { body: { token } });
      ok = true;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      message = e.message;
    }
  }
  return (
    <main>
      <h1>{ok ? 'Email confirmed' : 'Could not confirm email'}</h1>
      <p>{ok ? 'Thanks, your email address is confirmed.' : message}</p>
      <Link href="/account">Go to your account</Link>
    </main>
  );
}
