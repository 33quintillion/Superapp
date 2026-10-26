import Link from 'next/link';
import { resetPassword } from '../actions';
import { ActionForm } from '../form-ui';

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <main>
        <h1>Link incomplete</h1>
        <p>Open the full link from your email, or <Link href="/forgot-password">request a new one</Link>.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Choose a new password</h1>
      <ActionForm
        action={resetPassword}
        submit="Save password"
        pending="Saving…"
        fields={[
          { name: 'token', label: '', hidden: true, defaultValue: token },
          { name: 'newPassword', label: 'New password', type: 'password', autoComplete: 'new-password', hint: 'At least 10 characters' },
          { name: 'confirm', label: 'Repeat new password', type: 'password', autoComplete: 'new-password' },
        ]}
        success={
          <p>
            Password changed. You have been signed out on every device. <Link href="/sign-in">Sign in</Link>
          </p>
        }
      />
    </main>
  );
}
