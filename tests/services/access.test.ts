import { describe, expect, it } from "vitest";
import { atLeast, ROLE_RANK } from "~/lib/access.server";

/**
 * The failure that matters here is not "a read-only member did something they
 * should not"; it is "the owner cannot open their own app". Every case below is
 * written from that direction.
 */

describe("atLeast", () => {
  it("lets the owner do everything", () => {
    for (const minimum of ["READ_ONLY", "STAFF", "ADMIN", "OWNER"] as const) {
      expect(atLeast("OWNER", minimum)).toBe(true);
    }
  });

  it("lets an admin run the shop but not the billing", () => {
    expect(atLeast("ADMIN", "STAFF")).toBe(true);
    expect(atLeast("ADMIN", "ADMIN")).toBe(true);
    expect(atLeast("ADMIN", "OWNER")).toBe(false);
  });

  it("lets staff do the day-to-day but not change settings", () => {
    expect(atLeast("STAFF", "STAFF")).toBe(true);
    expect(atLeast("STAFF", "ADMIN")).toBe(false);
  });

  it("lets a read-only member read and nothing else", () => {
    expect(atLeast("READ_ONLY", "READ_ONLY")).toBe(true);
    expect(atLeast("READ_ONLY", "STAFF")).toBe(false);
  });

  it("orders the roles strictly, so no two are interchangeable", () => {
    const ranks = Object.values(ROLE_RANK);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ROLE_RANK.OWNER).toBeGreaterThan(ROLE_RANK.ADMIN);
    expect(ROLE_RANK.ADMIN).toBeGreaterThan(ROLE_RANK.STAFF);
    expect(ROLE_RANK.STAFF).toBeGreaterThan(ROLE_RANK.READ_ONLY);
  });
});
