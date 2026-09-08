/**
 * The AliExpress request signature.
 *
 * Every live call fails if this is wrong by one character, and nothing else in
 * the app would notice: the gateway answers with an `error_response` that reads
 * like a permissions problem. The expected values below are pinned so a
 * refactor of the sort or the concatenation is caught here rather than by a
 * merchant whose orders stop going through.
 */
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { signTopParams } from "~/services/suppliers/aliexpress.server";

const SECRET = "topsecret";

describe("signTopParams", () => {
  it("signs a /sync gateway call", () => {
    const signature = signTopParams(SECRET, {
      app_key: "12345",
      method: "aliexpress.ds.product.get",
      timestamp: "1700000000000",
      sign_method: "sha256",
      format: "json",
      v: "2.0",
      product_id: "1005006001",
    });
    expect(signature).toBe("161C5FE8AA9D7D5F86B3E2DDD9A7086955C57D94FA895140E52EE8C953566CC8");
  });

  it("prefixes the API path for the /rest gateway", () => {
    const signature = signTopParams(
      SECRET,
      {
        app_key: "12345",
        timestamp: "1700000000000",
        sign_method: "sha256",
        code: "abc",
        client_id: "12345",
        client_secret: "topsecret",
      },
      "/auth/token/create",
    );
    expect(signature).toBe("32A46299BE90E2A4C6B66B4C1FE00B8AF9BF3684E22C3D0675C6C23F61875103");
  });

  it("does not depend on the order the parameters were built in", () => {
    const a = signTopParams(SECRET, { b: "2", a: "1", c: "3" });
    const b = signTopParams(SECRET, { c: "3", a: "1", b: "2" });
    expect(a).toBe(b);
  });

  it("sorts by code point, not by locale", () => {
    // `localeCompare` puts "_" and "-" in a locale-dependent place, and AliExpress
    // sorts by byte. A key set that separates the two orderings must sign the
    // same way on every machine.
    const params = { a_b: "1", ab: "2", "a-b": "3", A: "4" };
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update("A4a-b3a_b1ab2", "utf8")
      .digest("hex")
      .toUpperCase();
    expect(signTopParams(SECRET, params)).toBe(expected);
  });

  it("is uppercase hex", () => {
    const signature = signTopParams(SECRET, { app_key: "1" });
    expect(signature).toMatch(/^[0-9A-F]{64}$/);
  });

  it("changes when any value changes", () => {
    const base = { app_key: "12345", method: "aliexpress.ds.product.get", timestamp: "1" };
    const other = { ...base, timestamp: "2" };
    expect(signTopParams(SECRET, base)).not.toBe(signTopParams(SECRET, other));
    expect(signTopParams(SECRET, base)).not.toBe(signTopParams("different", base));
  });
});
