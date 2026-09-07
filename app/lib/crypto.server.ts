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
 * Encrypt a supplier token at rest. With no ENCRYPTION_KEY configured the value
 * is stored as-is so local development works, and a warning is surfaced by the
 * settings page rather than failing the write.
 */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const k = key();
  if (!k) return plain;
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
