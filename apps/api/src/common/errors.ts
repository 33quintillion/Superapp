import { HttpStatus } from '@nestjs/common';

/** Error with a stable machine-readable code that is safe to show to clients. */
export class AppError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: unknown) => new AppError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Request validation failed', details),
  unauthorized: (message = 'Authentication required') => new AppError(HttpStatus.UNAUTHORIZED, 'unauthorized', message),
  invalidCredentials: () => new AppError(HttpStatus.UNAUTHORIZED, 'invalid_credentials', 'Email or password is incorrect'),
  forbidden: (message = 'Not allowed') => new AppError(HttpStatus.FORBIDDEN, 'forbidden', message),
  notFound: (what = 'Resource') => new AppError(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`),
  conflict: (code: string, message: string, details?: unknown) => new AppError(HttpStatus.CONFLICT, code, message, details),
  accountSuspended: () =>
    new AppError(HttpStatus.FORBIDDEN, 'account_suspended', 'This account has been suspended. Contact support if you think this is a mistake.'),
  invalidToken: () => new AppError(HttpStatus.BAD_REQUEST, 'invalid_token', 'This link or code is invalid or has expired'),
  rateLimited: (retryAfter: number) =>
    new AppError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', 'Too many requests, try again later', { retryAfter }),
};
