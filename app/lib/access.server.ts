import type { StaffRole } from "@prisma/client";
import prisma from "~/db.server";

/**
 * What a signed-in team member is allowed to do.
 *
 * The Staff page could already invite people and give them a role, but nothing
 * read the role back, so an invited READ_ONLY member had exactly the same powers
 * as the owner. This is where the role starts to mean something.
 *
 * Two rules keep it from ever locking anyone out:
 *
 *   - Somebody with no staff row is treated as the owner. That is the state
 *     every existing install is in, and a shop whose owner cannot open their own
 *     app is a far worse failure than one where a role is not yet applied.
 *   - A role only ever removes power. It is never the thing that grants it.
 */

export const ROLE_RANK: Record<StaffRole, number> = {
  READ_ONLY: 1,
  STAFF: 2,
  ADMIN: 3,
  OWNER: 4,
};

export interface Access {
  /** Shopify staff email, or "merchant" when Shopify did not name anyone. */
  actor: string;
  role: StaffRole;
  /** True when the role came from a staff row rather than the owner default. */
  fromStaffRow: boolean;
}

export function atLeast(role: StaffRole, minimum: StaffRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Resolve the role for this request.
 *
 * `disabledAt` is honoured by refusing everything but reading: a removed member
 * whose Shopify access has not yet been revoked should not still be placing
 * supplier orders, but locking them out of the screen entirely would look like
 * a broken app rather than a revoked account.
 */
export async function resolveAccess(accountId: string | null, shopDomain: string, actor: string): Promise<Access> {
  // No account row means no team to belong to, and Shopify not naming anyone
  // means there is nobody to look up. Both are the owner working alone.
  if (!accountId || !actor || actor === "merchant") return { actor: actor || "merchant", role: "OWNER", fromStaffRow: false };

  const row = await prisma.staffAccount.findUnique({
    where: { accountId_email: { accountId, email: actor.toLowerCase() } },
    select: { role: true, disabledAt: true, shopScopes: true },
  });
  if (!row) return { actor, role: "OWNER", fromStaffRow: false };
  if (row.disabledAt) return { actor, role: "READ_ONLY", fromStaffRow: true };

  // An empty scope list means every shop on the account; a non-empty one that
  // omits this shop means they may look but not act on it.
  const scoped = row.shopScopes.length === 0 || row.shopScopes.includes(shopDomain);
  return { actor, role: scoped ? row.role : "READ_ONLY", fromStaffRow: true };
}
