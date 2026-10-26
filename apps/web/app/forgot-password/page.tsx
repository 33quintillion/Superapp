import { forgotPassword } from '../actions';
import { ActionForm } from '../form-ui';

export default function ForgotPage() {
  return (
    <main>
      <h1>Reset your password</h1>
      <ActionForm
        action={forgotPassword}
        submit="Send reset link"
        pending="Sending…"
        fields={[{ name: 'email', label: 'Email', type: 'email', autoComplete: 'email' }]}
        success={<p>If an account uses that email, we have sent a link to reset the password. It expires in 30 minutes.</p>}
      />
    </main>
  );
}
