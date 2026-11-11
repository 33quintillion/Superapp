import { submitMfa } from '../../actions';
import { AuthShell } from '../../auth-shell';
import { ActionForm } from '../../form-ui';

export default function MfaPage() {
  return (
    <AuthShell title="Two-step verification" lede="Enter the 6-digit code from your authenticator app.">
      <ActionForm action={submitMfa} submit="Verify" pending="Checking…" fields={[{ name: 'code', label: 'Code', autoComplete: 'one-time-code' }]} />
    </AuthShell>
  );
}
