import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE } from '@/lib/cookies';

export default async function Home() {
  if ((await cookies()).get(ACCESS_COOKIE)) redirect('/account');
  return (
    <main className="stack">
      <h1>Messaging, social and services in one place.</h1>
      <p className="muted">This early build supports accounts: sign-up, sign-in, two-step verification, and device management.</p>
      <Link className="btn" href="/register" style={{ textAlign: 'center', textDecoration: 'none' }}>
        Create an account
      </Link>
      <Link href="/sign-in">I already have an account</Link>
    </main>
  );
}
