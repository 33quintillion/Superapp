import { submitMfa } from '../../actions';
import { ActionForm } from '../../form-ui';

export default function MfaPage() {
  return (
    <main>
      <h1>Two-step verification</h1>
      <p className="muted">Enter the 6-digit code from your authenticator app.</p>
      <ActionForm
        action={submitMfa}
        submit="Verify"
        pending="Checking…"
        fields={[{ name: 'code', label: 'Code', autoComplete: 'one-time-code' }]}
      />
    </main>
  );
}
