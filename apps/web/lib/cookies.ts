export const ACCESS_COOKIE = 'nexa_at';
export const REFRESH_COOKIE = 'nexa_rt';
export const MFA_COOKIE = 'nexa_mfa';

const secure = process.env.NODE_ENV === 'production';

export const cookieOpts = (maxAge: number) => ({
  httpOnly: true,
  secure,
  sameSite: 'lax' as const,
  path: '/',
  maxAge,
});

export const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;
