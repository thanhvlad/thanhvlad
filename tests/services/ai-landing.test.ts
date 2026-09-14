import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { aiEndpointStatus, createRewriteClient, extractResult, mightBeTheImages, rateLimitWaitMs, rewriteWasNotBilled } from "~/services/ai-landing.server";

/**
 * These two helpers exist because the app can be pointed at an
 * Anthropic-compatible gateway, and gateways misbehave in ways the real API
 * does not: one tested against here returned prose where structured output was
 * asked for, and rejected any request that carried both a long system block and
 * images. Every case below is a shape one of them actually produced.
 */

const PAGE = { title: "A Title", descriptionHtml: "<p>x</p>", tags: ["a"], heroImageIndex: 0, imageVerdicts: [] };

describe("extractResult", () => {
  it("takes a clean JSON object", () => {
    expect(extractResult(JSON.stringify(PAGE))).toEqual(PAGE);
  });

  it("takes an object wrapped in a code fence", () => {
    expect(extractResult("```json\n" + JSON.stringify(PAGE) + "\n```")).toEqual(PAGE);
  });

  it("takes an object behind a lead-in sentence", () => {
    expect(extractResult("Here is the page you asked for:\n" + JSON.stringify(PAGE))).toEqual(PAGE);
  });

  it("keeps a brace that is inside a string value", () => {
    const withBrace = { ...PAGE, descriptionHtml: '<p>Use the {size} guide</p>' };
    expect(extractResult("Result: " + JSON.stringify(withBrace))).toEqual(withBrace);
  });

  it("keeps an escaped quote inside a string value", () => {
    const quoted = { ...PAGE, title: 'The 6" Model' };
    expect(extractResult(JSON.stringify(quoted))).toEqual(quoted);
  });

  it("stops at the end of the first object, not the last brace in the text", () => {
    expect(extractResult(JSON.stringify(PAGE) + "\nLet me know if you want changes {or more}.")).toEqual(PAGE);
  });

  it("returns null for prose with no object at all", () => {
    expect(extractResult("I cannot help with that request.")).toBeNull();
  });

  it("returns null for a truncated object", () => {
    expect(extractResult('{"title": "A Title", "descriptionHtml": "<p>x')).toBeNull();
  });

  it("refuses a bare array, which is not a result", () => {
    expect(extractResult("[1, 2, 3]")).toBeNull();
  });
});

describe("mightBeTheImages", () => {
  it("retries without images on the statuses that mean 'not as shaped'", () => {
    for (const status of [400, 403, 413, 422]) {
      expect(mightBeTheImages({ status })).toBe(true);
    }
  });

  it("leaves auth, rate limits and server faults alone", () => {
    for (const status of [401, 429, 500, 502, 529]) {
      expect(mightBeTheImages({ status })).toBe(false);
    }
  });

  it("survives an error with no status", () => {
    expect(mightBeTheImages(new Error("socket hang up"))).toBe(false);
    expect(mightBeTheImages(null)).toBe(false);
  });
});

describe("aiEndpointStatus", () => {
  const saved = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
  afterEach(() => {
    if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
  });

  it("reports Anthropic's own API when no base url is set", () => {
    delete process.env.ANTHROPIC_BASE_URL;
    expect(aiEndpointStatus()).toMatchObject({ host: "api.anthropic.com", direct: true });
  });

  it("names a third-party gateway instead of hiding it", () => {
    // Production runs exactly like this; the SDK would follow it silently.
    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.net/v1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(aiEndpointStatus()).toEqual({ configured: true, host: "gateway.example.net", direct: false });
  });

  it("does not mistake a lookalike host for Anthropic", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com.evil.example";
    expect(aiEndpointStatus().direct).toBe(false);
  });

  it("survives a base url that is not a url", () => {
    process.env.ANTHROPIC_BASE_URL = "not a url";
    expect(aiEndpointStatus().direct).toBe(false);
  });
});

describe("rewriteWasNotBilled", () => {
  const gateway = { direct: false };
  const direct = { direct: true };
  const apiError = (status: number) => new Anthropic.APIError(status, undefined, `status ${status}`, new Headers());

  it("gives back a request refused before any model ran, through a gateway or directly", () => {
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      expect(rewriteWasNotBilled(apiError(status), gateway), `gateway ${status}`).toBe(true);
      expect(rewriteWasNotBilled(apiError(status), direct), `direct ${status}`).toBe(true);
    }
  });

  it("gives back Anthropic's own 500 and 529, which it raises instead of running the request", () => {
    expect(rewriteWasNotBilled(apiError(500), direct)).toBe(true);
    expect(rewriteWasNotBilled(apiError(529), direct)).toBe(true);
  });

  it("keeps every 5xx counted through a gateway, where the model may have finished upstream", () => {
    // Production's configuration: a gateway that gives up on a long generation
    // answers 502/504/524 after the upstream call was billed.
    for (const status of [500, 502, 503, 504, 524, 529]) {
      expect(rewriteWasNotBilled(apiError(status), gateway), `gateway ${status}`).toBe(false);
    }
  });

  it("keeps other statuses counted even directly", () => {
    for (const status of [408, 409, 502, 503, 504]) {
      expect(rewriteWasNotBilled(apiError(status), direct), `direct ${status}`).toBe(false);
    }
  });

  it("charges a dropped connection or timeout, where the model may have finished anyway", () => {
    expect(rewriteWasNotBilled(new Anthropic.APIConnectionError({ message: "socket hang up" }), direct)).toBe(false);
    expect(rewriteWasNotBilled(new Anthropic.APIConnectionTimeoutError(), direct)).toBe(false);
  });

  it("charges an answer that came back and would not parse", () => {
    expect(rewriteWasNotBilled(new Error("The endpoint returned no JSON object."), direct)).toBe(false);
  });

  describe("reading the endpoint from the environment", () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    afterEach(() => {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    });

    it("treats a 529 as billed once ANTHROPIC_BASE_URL names a gateway", () => {
      process.env.ANTHROPIC_BASE_URL = "https://gateway.example.net/v1";
      expect(rewriteWasNotBilled(apiError(529))).toBe(false);
      delete process.env.ANTHROPIC_BASE_URL;
      expect(rewriteWasNotBilled(apiError(529))).toBe(true);
    });
  });
});

describe("createRewriteClient", () => {
  it("never retries on its own, so one reserved rewrite is one request", () => {
    const client = createRewriteClient();
    expect(client.maxRetries).toBe(0);
  });
});

describe("rateLimitWaitMs", () => {
  const limited = (retryAfter?: string) =>
    new Anthropic.APIError(429, undefined, "rate limited", new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }));

  it("waits as long as the endpoint asks", () => {
    expect(rateLimitWaitMs(limited("7"))).toBe(7_000);
  });

  it("caps the wait so one product cannot hold a batch for minutes", () => {
    expect(rateLimitWaitMs(limited("600"))).toBe(30_000);
  });

  it("uses a short default when the endpoint gives no hint", () => {
    expect(rateLimitWaitMs(limited())).toBe(5_000);
    expect(rateLimitWaitMs(limited("soon"))).toBe(5_000);
  });

  it("retries only rate limits, never an answer that may have been billed", () => {
    expect(rateLimitWaitMs(new Anthropic.APIError(500, undefined, "x", new Headers()))).toBeNull();
    expect(rateLimitWaitMs(new Anthropic.APIConnectionTimeoutError())).toBeNull();
    expect(rateLimitWaitMs(new Error("nope"))).toBeNull();
  });
});
