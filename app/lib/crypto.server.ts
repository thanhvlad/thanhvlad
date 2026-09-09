import crypto from "node:crypto";
import { env } from "./env.server";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const raw = env().ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypt a supplier token at rest.
 *
 * Without ENCRYPTION_KEY the value is stored as-is so local development works
 * with no setup. In production that is a refusal, not a warning: a supplier
 * OAuth token in plaintext is a credential for the merchant's supplier account,
 * and a silent fallback is exactly how it ends up shipped.
 */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const k = key();
  if (!k) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ENCRYPTION_KEY is not set. Supplier tokens would be stored in plaintext. Set it to 32 random bytes, base64 (openssl rand -base64 32).",
      );
    }
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) return null;
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(".");
  try {
    const decipher = crypto.createDecipheriv(ALGO, k, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export function encryptionConfigured(): boolean {
  return key() !== null;
}
