import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors';

/**
 * Single place that turns exceptions into responses. Unknown errors are logged with
 * the request id and returned as a generic 500 so internals never leak to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = req.id;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { code: 'internal_error', message: 'Something went wrong' };

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details };
      if (exception.code === 'rate_limited') {
        reply.header('Retry-After', String((exception.details as { retryAfter: number }).retryAfter));
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { code: status === 404 ? 'not_found' : 'http_error', message: exception.message };
    } else if ((exception as { statusCode?: number })?.statusCode === 400 || (exception as { code?: string })?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      // Fastify body-parser errors (malformed JSON, wrong content type).
      status = HttpStatus.BAD_REQUEST;
      body = { code: 'bad_request', message: 'Malformed request body' };
    } else {
      this.logger.error({ requestId, err: exception }, 'Unhandled error');
    }

    reply.status(status).send({ error: { ...body, requestId } });
  }
}
