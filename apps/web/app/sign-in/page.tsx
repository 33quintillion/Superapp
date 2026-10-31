import Link from 'next/link';
import { emailSignupOpen, phoneConfig } from '@/lib/phone-config';
import { signIn } from '../actions';
import { ActionForm } from '../form-ui';
import { PhoneSignIn } from '../phone-sign-in';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  const phone = phoneConfig();
  return (
    <main>
      <h1>Sign in</h1>
      {expired && <p className="muted">Your session ended. Please sign in again.</p>}
      {phone && (
        <>
          <p className="muted">New here? Enter your number and we’ll set up your account.</p>
          <PhoneSignIn config={phone} />
          <h2>Signed up with email before?</h2>
        </>
      )}
      <ActionForm
        action={signIn}
        submit="Sign in with email"
        pending="Signing in…"
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
        ]}
      />
      <p>
        <Link href="/forgot-password">Forgot your password?</Link>
        {emailSignupOpen() && (
          <>
            {' '}
            · <Link href="/register">Create an account with email</Link>
          </>
        )}
      </p>
    </main>
  );
}
