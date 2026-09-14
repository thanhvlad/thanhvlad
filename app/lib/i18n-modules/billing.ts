/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 *
 * Billing lifecycle on the Plan and Stores screens: the one-time trial and the
 * single-use invite codes that link stores into one account.
 */
export const en = {
  "billing.plan.trialUsed": "Free trial already used on this store",
  "billing.stores.inviteLabel": "Invite code",
  "billing.stores.inviteHelp": "Works once and expires {date}. Paste it under Settings → Stores on the store you want to bring into this account.",
  "billing.stores.inviteNone": "Create a single-use code, then paste it under Settings → Stores on the store you want to bring into this account. The store joins this account's plan.",
  "billing.stores.inviteCreate": "Create invite code",
  "billing.stores.inviteReplace": "Create a new code",
  "billing.stores.inviteCopy": "Copy invite code",
  "billing.stores.inviteCopied": "Invite code copied.",
  "billing.stores.inviteCreated": "Invite code created. It works once and expires in 24 hours.",
  "billing.stores.ownerOnly": "Only the account owner can create invite codes or move a store between accounts.",
  "billing.stores.error.codeInvalid": "That invite code is not valid or has expired. Ask the account owner for a new one.",
  "billing.stores.error.sameAccount": "This store is already on that account.",
  "billing.stores.error.payingStore": "This store pays for the account's {plan} plan. Downgrade to Basic under Settings → Plan before moving it to another account.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "billing.plan.trialUsed": "Cửa hàng này đã dùng hết thời gian dùng thử",
  "billing.stores.inviteLabel": "Mã mời",
  "billing.stores.inviteHelp": "Chỉ dùng được một lần và hết hạn lúc {date}. Dán mã vào Cài đặt → Cửa hàng ở cửa hàng bạn muốn đưa vào tài khoản này.",
  "billing.stores.inviteNone": "Tạo mã dùng một lần, rồi dán vào Cài đặt → Cửa hàng ở cửa hàng bạn muốn đưa vào tài khoản này. Cửa hàng đó sẽ dùng chung gói của tài khoản.",
  "billing.stores.inviteCreate": "Tạo mã mời",
  "billing.stores.inviteReplace": "Tạo mã mới",
  "billing.stores.inviteCopy": "Sao chép mã mời",
  "billing.stores.inviteCopied": "Đã sao chép mã mời.",
  "billing.stores.inviteCreated": "Đã tạo mã mời. Mã chỉ dùng được một lần và hết hạn sau 24 giờ.",
  "billing.stores.ownerOnly": "Chỉ chủ tài khoản mới tạo được mã mời hoặc chuyển cửa hàng sang tài khoản khác.",
  "billing.stores.error.codeInvalid": "Mã mời không đúng hoặc đã hết hạn. Hãy xin chủ tài khoản một mã mới.",
  "billing.stores.error.sameAccount": "Cửa hàng này đã thuộc tài khoản đó rồi.",
  "billing.stores.error.payingStore": "Cửa hàng này đang trả tiền cho gói {plan} của tài khoản. Hãy hạ về gói Basic trong Cài đặt → Gói dịch vụ trước khi chuyển nó sang tài khoản khác.",
};
