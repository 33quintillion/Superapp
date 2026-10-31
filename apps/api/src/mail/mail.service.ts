import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config/config';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends transactional email over SMTP: Mailpit in local dev, a real provider in
 * staging/production. The "memory" transport exists only for automated tests
 * (config refuses it outside NODE_ENV=test) so tests can read the links sent.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transport?: Transporter;
  readonly sent: OutgoingMail[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.MAIL_TRANSPORT !== 'smtp') return;
    // The sign-in is passed as is, not inside the URL, where nodemailer would keep some characters percent-encoded.
    this.transport = config.SMTP_USER
      ? createTransport({ url: config.SMTP_URL, auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } as Parameters<typeof createTransport>[0])
      : createTransport(config.SMTP_URL);
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (!this.transport) {
      this.sent.push(mail);
      return;
    }
    await this.transport.sendMail({ from: this.config.MAIL_FROM, ...mail });
    // Never log message bodies: they contain one-time links.
    this.logger.log(`Sent "${mail.subject}"`);
  }
}
