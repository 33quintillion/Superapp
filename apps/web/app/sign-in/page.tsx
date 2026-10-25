import Link from 'next/link';
import { signIn } from '../actions';
import { ActionForm } from '../form-ui';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  return (
    <main>
      <h1>Sign in</h1>
      {expired && <p className="muted">Your session ended. Please sign in again.</p>}
      <ActionForm
        action={signIn}
        submit="Sign in"
        pending="Signing in…"
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
        ]}
      />
      <p>
        <Link href="/forgot-password">Forgot your password?</Link> · <Link href="/register">Create an account</Link>
      </p>
    </main>
  );
}
