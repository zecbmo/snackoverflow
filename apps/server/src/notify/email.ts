import nodemailer from 'nodemailer';
import type { Config } from '../config';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

/** SMTP mailer; null when SMTP isn't configured (email features then hide). */
export function createMailer(config: Config): Mailer | null {
  if (!config.SMTP_HOST) return null;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } : undefined,
  });
  return {
    async send(msg) {
      await transport.sendMail({ from: config.SMTP_FROM, ...msg });
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
