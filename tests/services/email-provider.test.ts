import { afterEach, describe, expect, it } from "vitest";
import { __setEmailSenderForTests, emailConfigured, emailProvider, sendEmail } from "~/services/email.server";

describe("email provider", () => {
  afterEach(() => __setEmailSenderForTests(null));

  it("is off by default and says so without throwing", async () => {
    expect(emailProvider()).toBe("none");
    expect(emailConfigured()).toBe(false);
    const result = await sendEmail({ to: "owner@example.com", subject: "x", text: "y" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/);
  });

  it("hands the message and the configured sender address to the wire", async () => {
    const seen: Array<{ to: string; from: string; subject: string }> = [];
    __setEmailSenderForTests(async (message, from) => {
      seen.push({ to: message.to, from, subject: message.subject });
      return { ok: true, id: "msg_1" };
    });
    expect(emailConfigured()).toBe(true);
    const result = await sendEmail({ to: "owner@example.com", subject: "Hello", text: "body" });
    expect(result).toMatchObject({ ok: true, id: "msg_1" });
    expect(seen).toEqual([{ to: "owner@example.com", from: "DropshipHub <no-reply@example.com>", subject: "Hello" }]);
  });
});
