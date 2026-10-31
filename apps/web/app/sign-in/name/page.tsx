import { completePhoneSignUp } from '../../actions';
import { ActionForm } from '../../form-ui';

export default function NamePage() {
  return (
    <main>
      <h1>Welcome to Nexa</h1>
      <p className="muted">Your number is confirmed. What should people call you?</p>
      <ActionForm
        action={completePhoneSignUp}
        submit="Create account"
        pending="Creating…"
        fields={[
          { name: 'displayName', label: 'Your name', autoComplete: 'name' },
          { name: 'username', label: 'Username (optional)', autoComplete: 'username', hint: '3-30 letters, numbers or underscores. Lets people find you without your number.', optional: true },
        ]}
      />
    </main>
  );
}
