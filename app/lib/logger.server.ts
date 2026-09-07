import { env } from "./env.server";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[env().LOG_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta ?? {}),
  };
  const text = JSON.stringify(line, replacer);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.info(text);
}

/** BigInt and Decimal are common in this codebase and neither is JSON-safe. */
function replacer(_key: string, value: unknown) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object" && "toFixed" in value && "toNumber" in value) {
    return String(value);
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
  child(bindings: Record<string, unknown>) {
    return {
      debug: (m: string, meta?: Record<string, unknown>) =>
        emit("debug", m, { ...bindings, ...meta }),
      info: (m: string, meta?: Record<string, unknown>) =>
        emit("info", m, { ...bindings, ...meta }),
      warn: (m: string, meta?: Record<string, unknown>) =>
        emit("warn", m, { ...bindings, ...meta }),
      error: (m: string, meta?: Record<string, unknown>) =>
        emit("error", m, { ...bindings, ...meta }),
    };
  },
};
