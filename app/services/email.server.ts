import nodemailer, { type Transporter } from "nodemailer";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

/**
 * Outbound email.
 *
 * Two providers, chosen from the environment: SMTP (any relay, via
 * `SMTP_URL`) or Resend's HTTP API (`RESEND_API_KEY`). With neither set the
 * app still works — notifications stay in the in-app feed and `sendEmail`
 * says so instead of throwing, because a missing mail server must never fail
 * the order sync that produced the notification.
 */

export type EmailProvider = "smtp" | "resend" | "none";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** For providers that support it; a bounce or reply goes here. */
  replyTo?: string;
}

export interface EmailResult {
  ok: boolean;
  provider: EmailProvider;
  id?: string;
  error?: string;
}

export type EmailSender = (message: EmailMessage, from: string) => Promise<Omit<EmailResult, "provider">>;

let smtpTransport: Transporter | null = null;
let smtpTransportUrl: string | null = null;
let senderOverride: EmailSender | null = null;

/** Tests swap the wire out; nothing else should call this. */
export function __setEmailSenderForTests(sender: EmailSender | null) {
  senderOverride = sender;
}

export function emailProvider(): EmailProvider {
  const config = env();
  if (config.EMAIL_PROVIDER === "none") return "none";
  if (config.EMAIL_PROVIDER === "smtp") return config.SMTP_URL ? "smtp" : "none";
  if (config.EMAIL_PROVIDER === "resend") return config.RESEND_API_KEY ? "resend" : "none";
  if (config.RESEND_API_KEY) return "resend";
  if (config.SMTP_URL) return "smtp";
  return "none";
}

export function emailConfigured(): boolean {
  return senderOverride !== null || emailProvider() !== "none";
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const config = env();
  const from = config.EMAIL_FROM;
  const provider = emailProvider();

  if (senderOverride) {
    const result = await senderOverride(message, from);
    return { ...result, provider };
  }
  if (!message.to.includes("@")) return { ok: false, provider, error: "No recipient address" };

  try {
    switch (provider) {
      case "smtp": {
        const transport = getSmtpTransport(config.SMTP_URL!);
        const info = await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html, replyTo: message.replyTo });
        return { ok: true, provider, id: info.messageId };
      }
      case "resend": {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${config.RESEND_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html, reply_to: message.replyTo }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
        if (!response.ok) return { ok: false, provider, error: body.message ?? `Resend returned ${response.status}` };
        return { ok: true, provider, id: body.id };
      }
      default:
        return { ok: false, provider, error: "Email delivery is not configured (set SMTP_URL or RESEND_API_KEY)." };
    }
  } catch (error) {
    logger.warn("Email delivery failed", { provider, to: message.to, error });
    return { ok: false, provider, error: error instanceof Error ? error.message : String(error) };
  }
}

function getSmtpTransport(url: string): Transporter {
  if (!smtpTransport || smtpTransportUrl !== url) {
    smtpTransport = nodemailer.createTransport(url);
    smtpTransportUrl = url;
  }
  return smtpTransport;
}
