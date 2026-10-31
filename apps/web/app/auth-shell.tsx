import styles from './auth.module.css';
import { Greeting } from './greeting';

/** How phone sign-in goes, shown beside the form. */
export const PHONE_STEPS = ['Enter your mobile number.', 'Type the 6-digit code we text you.', 'New to SuperApp? Add your name and you’re in.'];

/**
 * The frame for signing in and signing up: one card on a softly tinted page, with a greeting
 * that changes between several of India's scripts, the title and steps on the left, and the
 * form on the right (below them on phones).
 */
export function AuthShell({
  title = 'Log in to SuperApp',
  lede,
  steps,
  children,
}: {
  title?: string;
  lede?: React.ReactNode;
  steps?: string[];
  children: React.ReactNode;
}) {
  return (
    <main className={styles.page} style={{ maxWidth: 'none', margin: 0 }}>
      <div className={styles.card}>
        <div className={styles.intro}>
          <Greeting />
          <h1 className={styles.heading}>{title}</h1>
          {lede && <p className={styles.lede}>{lede}</p>}
          {steps && (
            <ol className={styles.steps}>
              {steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
        </div>
        <div className={styles.side}>{children}</div>
      </div>
      <p className={styles.note}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z" />
        </svg>
        Codes come by SMS. Businesses on SuperApp never see your number.
      </p>
    </main>
  );
}
