import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig, parseMailbox } from '../config/config';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends transactional email over SMTP (Mailpit in local dev, a provider when deployed) or
 * Brevo's HTTPS API, for hosts that block outbound SMTP. The "memory" transport exists only
 * for automated tests (config refuses it outside NODE_ENV=test) so tests can read the links sent.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transport?: Transporter;
  readonly sent: OutgoingMail[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.MAIL_TRANSPORT !== 'smtp') return;
    const timeouts = { connectionTimeout: config.MAIL_TIMEOUT_MS, greetingTimeout: config.MAIL_TIMEOUT_MS, socketTimeout: config.MAIL_TIMEOUT_MS };
    // The sign-in is passed as is, not inside the URL, where nodemailer would keep some characters percent-encoded.
    this.transport = config.SMTP_USER
      ? createTransport({ url: config.SMTP_URL, auth: { user: config.SMTP_USER, pass: config.SMTP_PASS }, ...timeouts } as Parameters<typeof createTransport>[0])
      : createTransport({ url: config.SMTP_URL, ...timeouts } as Parameters<typeof createTransport>[0]);
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (this.config.MAIL_TRANSPORT === 'brevo') {
      await this.sendWithBrevo(mail);
    } else if (!this.transport) {
      this.sent.push(mail);
      return;
    } else {
      await this.transport.sendMail({ from: this.config.MAIL_FROM, ...mail });
    }
    // Never log message bodies: they contain one-time links.
    this.logger.log(`Sent "${mail.subject}"`);
  }

  /** https://developers.brevo.com/reference/sendtransacemail */
  private async sendWithBrevo(mail: OutgoingMail) {
    const sender = parseMailbox(this.config.MAIL_FROM) as { name?: string; email: string };
    const res = await fetch(`${this.config.BREVO_API_BASE ?? 'https://api.brevo.com'}/v3/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': this.config.BREVO_API_KEY as string, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: mail.to }], subject: mail.subject, textContent: mail.text }),
      signal: AbortSignal.timeout(this.config.MAIL_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Brevo's error body names the problem (e.g. unauthorized IP, unverified sender) and never echoes the key.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Brevo refused the email: ${res.status} ${detail}`);
    }
  }
}
