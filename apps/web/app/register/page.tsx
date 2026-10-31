import Link from 'next/link';
import { emailSignupOpen, phoneConfig } from '@/lib/phone-config';
import { register } from '../actions';
import { ActionForm } from '../form-ui';
import { PhoneSignIn } from '../phone-sign-in';

export const dynamic = 'force-dynamic';

export default function RegisterPage() {
  const phone = phoneConfig();
  const email = emailSignupOpen();
  return (
    <main>
      <h1>Create your account</h1>
      {phone && <PhoneSignIn config={phone} />}
      {!phone && !email && <p className="muted">Sign-up isn’t open yet.</p>}
      {email && (
        <>
          {phone && <h2>Or with email</h2>}
          <ActionForm
            action={register}
            submit="Create account"
            pending="Creating…"
            fields={[
              { name: 'displayName', label: 'Display name', autoComplete: 'name' },
              { name: 'username', label: 'Username', autoComplete: 'username', hint: '3-30 letters, numbers or underscores' },
              { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
              { name: 'password', label: 'Password', type: 'password', autoComplete: 'new-password', hint: 'At least 10 characters' },
            ]}
          />
        </>
      )}
      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </main>
  );
}
