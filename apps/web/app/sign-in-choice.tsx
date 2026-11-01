'use client';

import { useState } from 'react';
import { AuthIntro, LINK_STEPS, PHONE_STEPS } from './auth-shell';
import styles from './auth.module.css';
import { LinkQr } from './link-qr';
import { PhoneSignIn } from './phone-sign-in';

interface PhoneConfig {
  apiKey: string;
  authBase: string;
  countryCode: string;
}

/**
 * The sign-in card with two ways in: a code by SMS, or scanning a QR code with the phone app
 * (as WhatsApp Web does). Each shows its own steps on the left.
 */
export function SignInChoice({ phone, notice, footer }: { phone: PhoneConfig; notice?: string; footer?: React.ReactNode }) {
  const [mode, setMode] = useState<'phone' | 'qr'>('phone');
  return (
    <div className={styles.card}>
      <AuthIntro steps={mode === 'qr' ? LINK_STEPS : PHONE_STEPS} />
      <div className={styles.side}>
        {notice && <p className="muted">{notice}</p>}
        {mode === 'qr' ? <LinkQr /> : <PhoneSignIn config={phone} />}
        <button type="button" className={`link-btn ${styles.switch}`} onClick={() => setMode(mode === 'qr' ? 'phone' : 'qr')}>
          {mode === 'qr' ? 'Log in with phone number instead' : 'Have SuperApp on your phone? Log in with a QR code'}
        </button>
        {footer}
      </div>
    </div>
  );
}
