import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/error.filter';
import { AppConfig } from './config/config';

/** Never written to logs, even if someone logs a whole request or body. */
export const LOG_REDACT = ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.refreshToken', '*.token', '*.accessToken'];

/** Builds the HTTP app. Shared by main.ts and the e2e tests so both run the same stack. */
export async function createApp(config: AppConfig, opts: { logger?: boolean; logStream?: NodeJS.WritableStream } = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            // Defence in depth: these must never reach logs even if someone logs a request.
            redact: LOG_REDACT,
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forConfig(config), adapter, {
    // Payment webhooks are verified against the exact bytes the provider signed.
    rawBody: true,
    logger: opts.logger === false ? false : NEST_LEVELS.slice(0, NEST_LEVELS.indexOf(nestLevel(config.LOG_LEVEL)) + 1),
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  const origins = config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: false });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
  });
  app.enableShutdownHooks();
  return app;
}

const NEST_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
function nestLevel(l: AppConfig['LOG_LEVEL']): (typeof NEST_LEVELS)[number] {
  return l === 'info' ? 'log' : l === 'trace' ? 'verbose' : l;
}
