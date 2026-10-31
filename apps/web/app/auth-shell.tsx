import styles from './auth.module.css';
import { Greeting } from './greeting';

/** Faint chat bubbles behind the greeting: position, size, and whether it's "your" bubble. */
const BUBBLES: [string, string, string, string, boolean][] = [
  ['9%', '9%', '42%', '46px', false],
  ['17%', '46%', '36%', '46px', true],
  ['25%', '58%', '24%', '46px', true],
  ['35%', '9%', '50%', '64px', false],
];

/**
 * The frame for signing in and signing up: a welcome panel in night indigo that says hello
 * in several of India's scripts, and the form on the right (below it on phones).
 */
export function AuthShell({ title, lede, children }: { title?: string; lede?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className={styles.shell} style={{ maxWidth: 'none', padding: 0, margin: 0 }}>
      <section className={styles.welcome} aria-label="Welcome">
        <div className={styles.bubbles} aria-hidden="true">
          {BUBBLES.map(([top, left, width, height, mine]) => (
            <span key={top} className={`${styles.bubble} ${mine ? styles.mine : ''}`} style={{ top, left, width, height }} />
          ))}
        </div>
        <Greeting />
        <p className={styles.pitch}>Chat, call, share moments and order from local shops, all with one number.</p>
        <p className={styles.pitchSmall}>Made for India first.</p>
      </section>
      <section className={styles.panel}>
        <div className={styles.form}>
          {title && <h1 className={styles.title}>{title}</h1>}
          {lede && <p className={styles.lede}>{lede}</p>}
          {children}
        </div>
      </section>
    </main>
  );
}
