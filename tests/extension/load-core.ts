/**
 * Evaluates extension/checkout-core.js the way Chrome loads it - a classic
 * script attaching to globalThis - inside a bare node:vm context, so the tests
 * exercise the exact file the extension ships, with no bundler in between.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

// The file is plain JavaScript with no types; the tests assert on its behaviour.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CheckoutCore = Record<string, any>;

export function extensionFile(name: string): string {
  return readFileSync(resolve(process.cwd(), "extension", name), "utf8");
}

export function loadCheckoutCore(): CheckoutCore {
  // URL is a web API, not a language intrinsic, so the context needs it handed
  // in; Intl and BigInt come with the context itself.
  const sandbox: Record<string, unknown> = { URL };
  vm.createContext(sandbox);
  vm.runInContext(extensionFile("checkout-core.js"), sandbox, { filename: "extension/checkout-core.js" });
  return sandbox.DropshipHubCheckout as CheckoutCore;
}
