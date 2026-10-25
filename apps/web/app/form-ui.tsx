'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormState } from './actions';

export function Submit({ label, pending: pendingLabel }: { label: string; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

export interface FieldDef {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
  defaultValue?: string;
  hidden?: boolean;
}

/** A progressively enhanced form: works as a plain POST without JavaScript. */
export function ActionForm({
  action,
  fields,
  submit,
  pending,
  success,
}: {
  action: (s: FormState, f: FormData) => Promise<FormState>;
  fields: FieldDef[];
  submit: string;
  pending: string;
  success?: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, {});
  if (state.done && success) return <div role="status">{success}</div>;
  return (
    <form action={formAction} className="stack">
      {fields.map((f) =>
        f.hidden ? (
          <input key={f.name} type="hidden" name={f.name} defaultValue={f.defaultValue} />
        ) : (
          <label key={f.name} className="field">
            <span>{f.label}</span>
            <input name={f.name} type={f.type ?? 'text'} autoComplete={f.autoComplete} defaultValue={state.values?.[f.name] ?? f.defaultValue} required />
            {f.hint && <small>{f.hint}</small>}
          </label>
        ),
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <Submit label={submit} pending={pending} />
    </form>
  );
}
