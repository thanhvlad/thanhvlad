import type { StaffRole } from "@prisma/client";
import prisma from "~/db.server";
import { logActivity } from "./activity.server";
import { assertWithinPlan } from "./billing.server";

/**
 * Staff accounts live on the parent Account so one team can manage every
 * store. Shopify handles authentication; this is authorisation metadata the
 * UI uses to hide destructive actions from read-only members.
 */

export async function listStaff(accountId: string) {
  return prisma.staffAccount.findMany({ where: { accountId }, orderBy: { invitedAt: "asc" } });
}

export async function inviteStaff(
  shopId: string,
  accountId: string,
  input: { email: string; name?: string | null; role: StaffRole; shopScopes?: string[] },
) {
  const email = input.email.trim().toLowerCase();
  // Re-inviting someone already on the team changes nothing about the count.
  const existing = await prisma.staffAccount.findUnique({ where: { accountId_email: { accountId, email } }, select: { id: true } });
  if (!existing) await assertWithinPlan({ accountId }, "staff", 1);
  const row = await prisma.staffAccount.upsert({
    where: { accountId_email: { accountId, email } },
    create: { accountId, email, name: input.name ?? null, role: input.role, shopScopes: input.shopScopes ?? [] },
    update: { name: input.name ?? undefined, role: input.role, shopScopes: input.shopScopes ?? [], disabledAt: null },
  });
  await logActivity(shopId, { action: "staff.invited", entity: "StaffAccount", entityId: row.id, message: `${email} invited as ${input.role}.` });
  return row;
}

/**
 * A staff row on the account that owns this shop.
 *
 * Both mutations below take an id from a form field, so without the scope any
 * signed-in merchant could promote or remove a member of another organisation.
 */
async function ownedStaff(shopId: string, id: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { accountId: true } });
  if (!shop?.accountId) throw new Error("Staff member not found");
  const row = await prisma.staffAccount.findFirst({ where: { id, accountId: shop.accountId } });
  if (!row) throw new Error("Staff member not found");
  return row;
}

export async function updateStaffRole(shopId: string, id: string, role: StaffRole, shopScopes?: string[]) {
  const owned = await ownedStaff(shopId, id);
  const row = await prisma.staffAccount.update({ where: { id: owned.id }, data: { role, ...(shopScopes ? { shopScopes } : {}) } });
  await logActivity(shopId, { action: "staff.updated", entity: "StaffAccount", entityId: id, message: `${row.email} is now ${role}.` });
  return row;
}

export async function removeStaff(shopId: string, id: string) {
  const owned = await ownedStaff(shopId, id);
  await prisma.staffAccount.delete({ where: { id: owned.id } });
  await logActivity(shopId, { action: "staff.removed", entity: "StaffAccount", entityId: id, message: `${owned.email} removed.` });
}

/** Role for the current Shopify user, defaulting to OWNER for the store owner. */
export async function roleForUser(accountId: string | null, email: string | null | undefined, accountOwner: boolean): Promise<StaffRole> {
  if (accountOwner || !accountId || !email) return "OWNER";
  const row = await prisma.staffAccount.findUnique({ where: { accountId_email: { accountId, email: email.toLowerCase() } } });
  if (!row || row.disabledAt) return "STAFF";
  return row.role;
}

export const ROLE_PERMISSIONS: Record<StaffRole, { canEdit: boolean; canOrder: boolean; canManageSettings: boolean; canManageStaff: boolean }> = {
  OWNER: { canEdit: true, canOrder: true, canManageSettings: true, canManageStaff: true },
  ADMIN: { canEdit: true, canOrder: true, canManageSettings: true, canManageStaff: false },
  STAFF: { canEdit: true, canOrder: true, canManageSettings: false, canManageStaff: false },
  READ_ONLY: { canEdit: false, canOrder: false, canManageSettings: false, canManageStaff: false },
};
