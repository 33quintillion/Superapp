import { completePhoneSignUp } from '../../actions';
import { AuthShell } from '../../auth-shell';
import { ActionForm } from '../../form-ui';

export default function NamePage() {
  return (
    <AuthShell title="What should people call you?" lede="Your number is confirmed. Add your name to finish setting up.">
      <ActionForm
        action={completePhoneSignUp}
        submit="Create account"
        pending="Creating…"
        fields={[
          { name: 'displayName', label: 'Your name', autoComplete: 'name' },
          { name: 'username', label: 'Username (optional)', autoComplete: 'username', hint: '3-30 letters, numbers or underscores. Lets people find you without your number.', optional: true },
        ]}
      />
    </AuthShell>
  );
}
