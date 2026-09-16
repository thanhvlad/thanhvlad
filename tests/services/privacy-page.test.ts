/**
 * The public privacy page names the host AI requests actually go to. The value
 * comes from operator configuration, so only a plain host is ever printed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/shopify.server", () => ({ authenticate: {}, unauthenticated: {}, apiVersion: "2026-07", default: {} }));

const { publicEndpointHost } = await import("~/routes/privacy");

const saved = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };

afterEach(() => {
  process.env.ANTHROPIC_BASE_URL = saved.base;
  process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
});

describe("privacy page AI endpoint", () => {
  it("prints a plain host and nothing else", () => {
    expect(publicEndpointHost("api.anthropic.com")).toBe("api.anthropic.com");
    expect(publicEndpointHost("Gateway.Example.com:8443")).toBe("gateway.example.com:8443");
    expect(publicEndpointHost("not a url/with?secret=1")).toBeNull();
    expect(publicEndpointHost("key@gateway")).toBeNull();
  });

  it("names the configured gateway rather than assuming Anthropic", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://user:secret@llm-gateway.example.net/v1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const { loader } = await import("~/routes/privacy");
    const data = await loader();
    expect(data.ai).toEqual({ configured: true, direct: false, host: "llm-gateway.example.net" });
    expect(JSON.stringify(data)).not.toContain("secret");
  });

  it("reports Anthropic's own API when no base url is set", async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    const { loader } = await import("~/routes/privacy");
    const data = await loader();
    expect(data.ai).toMatchObject({ direct: true, host: "api.anthropic.com" });
  });
});
