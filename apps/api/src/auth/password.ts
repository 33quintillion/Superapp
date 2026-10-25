import * as argon2 from 'argon2';

// OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1).
const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => argon2.hash(pw, OPTS);

export async function verifyPassword(hash: string | null, pw: string): Promise<boolean> {
  // Always do the work, even with no account, so response time does not reveal which emails exist.
  if (!hash) {
    await argon2.verify(await dummyHash, pw).catch(() => false);
    return false;
  }
  return argon2.verify(hash, pw).catch(() => false);
}

const dummyHash = argon2.hash('not-a-real-password-placeholder', OPTS);
