import 'server-only';

/**
 * Firebase settings for phone sign-in. The web API key and project ID are public by design
 * (Firebase puts them in every web app); what stops abuse is reCAPTCHA, the authorized
 * domains list in Firebase, and the API checking each ID token.
 */
export interface PhoneConfig {
  apiKey: string;
  /** Identity Toolkit, overridable so browser tests can use a stand-in. */
  authBase: string;
  /** Shown before the number field; the API decides which countries are allowed. */
  countryCode: string;
}

export function phoneConfig(env: Record<string, string | undefined> = process.env): PhoneConfig | null {
  if (!env.FIREBASE_WEB_API_KEY) return null;
  return {
    apiKey: env.FIREBASE_WEB_API_KEY,
    authBase: env.FIREBASE_AUTH_BASE ?? 'https://identitytoolkit.googleapis.com',
    countryCode: env.PHONE_DEFAULT_COUNTRY_CODE ?? '+91',
  };
}

/** Email and password sign-up, off unless the API also has it on (EMAIL_SIGNUP). */
export const emailSignupOpen = (env: Record<string, string | undefined> = process.env) => env.EMAIL_SIGNUP === 'true';
