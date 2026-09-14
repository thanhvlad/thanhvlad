/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 *
 * Billing lifecycle on the Plan and Stores screens: the one-time trial, the
 * monthly AI rewrite allowance and the single-use invite codes that link
 * stores into one account. Also the webhook delivery health shown on
 * Settings → Advanced, which belongs to the same install lifecycle.
 */
export const en = {
  "billing.plan.trialUsed": "Free trial already used on this store",
  "billing.plan.aiRewrites": "{n} AI product page rewrites a month",
  "billing.plan.aiRewritesOne": "1 AI product page rewrite a month",
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
  "billing.stores.accountHelp": "Stores on one account share supplier connections, staff and the account's plan. To add another store, install the app on it, create an invite code here, then enter the code under Settings → Stores on that store.",
  "billing.stores.linkDescription": "Enter an invite code from another account's owner to move this store there. Supplier connections, staff and the plan are shared; pricing rules stay per store.",
  "billing.stores.codePlaceholder": "XXXX-XXXX-XXXX",
  "billing.stores.joinConfirmBody": "This store joins the account that created invite code {code} and uses that account's plan. If it was the last store on its old account, that account is removed.",

  // ---- Settings → Advanced: webhook delivery health -------------------------
  "billing.webhooks.attempts": "Attempts",
  "billing.webhooks.gaveUp": "Gave up",
  "billing.webhooks.retrying": "Retrying",
  "billing.webhooks.abandoned.title": "Shopify events the app stopped retrying",
  "billing.webhooks.abandoned.body": "These events kept failing until their retry window closed (two days, or 30 days for privacy requests), so the app stopped trying. Anything they should have changed, such as an order update or a customer data request, did not happen. Contact support with the details below.",
  "billing.webhooks.abandoned.item": "{topic}, received {date}, {attempts} attempts",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "billing.plan.trialUsed": "Cửa hàng này đã dùng hết thời gian dùng thử",
  "billing.plan.aiRewrites": "{n} lượt AI viết lại trang sản phẩm mỗi tháng",
  "billing.plan.aiRewritesOne": "1 lượt AI viết lại trang sản phẩm mỗi tháng",
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
  "billing.stores.accountHelp": "Các cửa hàng trong cùng một tài khoản dùng chung kết nối nhà cung cấp, nhân viên và gói dịch vụ. Để thêm cửa hàng, hãy cài ứng dụng lên cửa hàng đó, tạo mã mời ở đây, rồi nhập mã vào Cài đặt → Cửa hàng bên cửa hàng kia.",
  "billing.stores.linkDescription": "Nhập mã mời do chủ tài khoản khác tạo để chuyển cửa hàng này sang tài khoản đó. Kết nối nhà cung cấp, nhân viên và gói dịch vụ được dùng chung; quy tắc giá vẫn riêng từng cửa hàng.",
  "billing.stores.joinConfirmBody": "Cửa hàng này sẽ tham gia tài khoản đã tạo mã mời {code} và dùng gói dịch vụ của tài khoản đó. Nếu đây là cửa hàng cuối cùng của tài khoản cũ, tài khoản cũ sẽ bị xoá.",

  "billing.webhooks.attempts": "Số lần thử",
  "billing.webhooks.gaveUp": "Đã ngừng thử",
  "billing.webhooks.retrying": "Đang thử lại",
  "billing.webhooks.abandoned.title": "Sự kiện Shopify ứng dụng đã ngừng thử lại",
  "billing.webhooks.abandoned.body": "Các sự kiện này lỗi liên tục cho tới khi hết thời hạn thử lại (hai ngày, hoặc 30 ngày với yêu cầu về quyền riêng tư), nên ứng dụng đã ngừng xử lý. Những thay đổi lẽ ra phải xảy ra, như cập nhật đơn hàng hay yêu cầu dữ liệu khách hàng, đã không được thực hiện. Hãy liên hệ hỗ trợ kèm các thông tin bên dưới.",
  "billing.webhooks.abandoned.item": "{topic}, nhận lúc {date}, thử {attempts} lần",
};
