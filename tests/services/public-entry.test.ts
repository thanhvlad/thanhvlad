/**
 * The app's public URL and the library's login path must never ask for a
 * myshopify.com domain (App Store requirement 2.3.1), while a real install or
 * admin launch — which always carries ?shop= — still goes straight in.
 */
import { describe, expect, it, vi } from "vitest";

const login = vi.hoisted(() => vi.fn());
vi.mock("~/shopify.server", () => ({ login, default: {} }));

const landing = await import("~/routes/_index/route");
const authLogin = await import("~/routes/auth.login/route");

async function thrownBy(run: () => unknown): Promise<Response> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("expected a thrown Response");
}

const args = (url: string, method = "GET") => ({ request: new Request(url, { method }), params: {}, context: {} });

describe("public landing page", () => {
  it("sends an install or admin launch into the app", async () => {
    const response = await thrownBy(() => landing.loader(args("https://app.example.com/?shop=demo.myshopify.com&host=abc")));
    expect(response.headers.get("Location")).toBe("/app?shop=demo.myshopify.com&host=abc");
  });

  it("renders marketing copy for everyone else, with no data a form would need", async () => {
    expect(await landing.loader(args("https://app.example.com/"))).toBeNull();
  });
});

describe("/auth/login", () => {
  it("sends a visitor without a shop to the public page, not to a domain field or an unpublished listing", async () => {
    const response = await thrownBy(() => authLogin.loader(args("https://app.example.com/auth/login")));
    expect(response.headers.get("Location")).toBe("/");
    expect(login).not.toHaveBeenCalled();
  });

  it("still lets the library log in a request that names a shop", async () => {
    login.mockResolvedValueOnce({});
    const result = await authLogin.loader(args("https://app.example.com/auth/login?shop=demo.myshopify.com"));
    expect(login).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ errors: {} });
  });

  it("answers an old form post with the public page too", async () => {
    const response = await authLogin.action();
    expect(response.headers.get("Location")).toBe("/");
  });

  it("lands on a page whose loader renders instead of redirecting again", async () => {
    const response = await thrownBy(() => authLogin.loader(args("https://app.example.com/auth/login")));
    const next = new URL(response.headers.get("Location") ?? "", "https://app.example.com");
    expect(await landing.loader(args(next.toString()))).toBeNull();
  });
});
