/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 */
export const en = {
  // ---- Suppliers: page ------------------------------------------------------
  "suppliers.addSupplier": "Add supplier",
  "suppliers.stat.connected": "Connected accounts",
  "suppliers.stat.attention": "Need attention",
  "suppliers.stat.attentionHint": "Reconnect or replace these before placing orders",
  "suppliers.stat.platforms": "Platforms ready",
  "suppliers.stat.platformsHint": "{ready} of {total} configured",
  "suppliers.stat.allGood": "All accounts working",

  // ---- Suppliers: account cards --------------------------------------------
  "suppliers.card.status.connected": "Connected",
  "suppliers.card.status.inactive": "Inactive",
  "suppliers.card.lastUsed": "Last used",
  "suppliers.card.tokenExpires": "Token expires",
  "suppliers.card.accountId": "Account ID",
  "suppliers.card.scope": "Used by",
  "suppliers.card.scope.allStores": "All my stores",
  "suppliers.card.scope.thisStore": "This store only",
  "suppliers.card.storeRegistered": "Store registered with supplier",

  // ---- Suppliers: empty state ----------------------------------------------
  "suppliers.emptyState.heading": "No supplier connected yet",
  "suppliers.emptyState.body": "Connect a supplier account to search catalogs and place orders automatically, or install the Chrome extension to add products straight from AliExpress.",

  // ---- Suppliers: add card ---------------------------------------------------
  "suppliers.addCard.title": "Add another supplier",
  "suppliers.addCard.body": "Connect AliExpress, CJ Dropshipping or a demo account for testing.",

  // ---- Suppliers: extension card -------------------------------------------
  "suppliers.extension.title": "Chrome extension",
  "suppliers.extension.badge": "Recommended",
  "suppliers.extension.body": "Browse AliExpress as usual and add any product to your import list with one click. No supplier login needed.",
  "suppliers.extension.step1": "Install the DropshipHub extension in Chrome.",
  "suppliers.extension.step2": "Generate an extension token in Settings → Advanced and paste it into the extension.",
  "suppliers.extension.step3": "Open a product on AliExpress and press \"Add to DropshipHub\".",
  "suppliers.extension.settingsLink": "Get your token in Settings → Advanced",

  // ---- Suppliers: add modal ------------------------------------------------
  "suppliers.modal.title": "Add supplier",
  "suppliers.modal.platform": "Supplier",
  "suppliers.modal.platformHelp": "Which platform this account belongs to.",
  "suppliers.modal.needsApiKeys": "Not available: the platform API keys are not configured on this server yet.",
  "suppliers.modal.oauthHelp": "You will be sent to the supplier's site to approve access, then brought back here.",
  "suppliers.modal.capabilities": "What this supplier can do",

  // ---- Suppliers: confirm disconnect ---------------------------------------
  "suppliers.disconnect.title": "Disconnect {label}?",
  "suppliers.disconnect.body": "Orders for this supplier will stop being placed until another account is connected. You can reconnect at any time.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "suppliers.addSupplier": "Thêm nhà cung cấp",
  "suppliers.stat.connected": "Tài khoản đã kết nối",
  "suppliers.stat.attention": "Cần xử lý",
  "suppliers.stat.attentionHint": "Kết nối lại hoặc thay tài khoản trước khi đặt hàng",
  "suppliers.stat.platforms": "Nền tảng sẵn sàng",
  "suppliers.stat.platformsHint": "{ready}/{total} đã cấu hình",
  "suppliers.stat.allGood": "Mọi tài khoản đều ổn",

  "suppliers.card.status.connected": "Đang kết nối",
  "suppliers.card.status.inactive": "Ngừng hoạt động",
  "suppliers.card.lastUsed": "Dùng lần cuối",
  "suppliers.card.tokenExpires": "Token hết hạn",
  "suppliers.card.accountId": "Mã tài khoản",
  "suppliers.card.scope": "Dùng cho",
  "suppliers.card.scope.allStores": "Tất cả cửa hàng của tôi",
  "suppliers.card.scope.thisStore": "Chỉ cửa hàng này",
  "suppliers.card.storeRegistered": "Đã đăng ký cửa hàng với nhà cung cấp",

  "suppliers.emptyState.heading": "Chưa kết nối nhà cung cấp nào",
  "suppliers.emptyState.body": "Kết nối tài khoản nhà cung cấp để tìm hàng và đặt đơn tự động, hoặc cài tiện ích Chrome để thêm sản phẩm ngay trên AliExpress.",

  "suppliers.addCard.title": "Thêm nhà cung cấp khác",
  "suppliers.addCard.body": "Kết nối AliExpress, CJ Dropshipping hoặc tài khoản demo để thử.",

  "suppliers.extension.title": "Tiện ích Chrome",
  "suppliers.extension.badge": "Nên dùng",
  "suppliers.extension.body": "Lướt AliExpress như bình thường và thêm sản phẩm vào danh sách nhập chỉ với một cú bấm. Không cần đăng nhập nhà cung cấp.",
  "suppliers.extension.step1": "Cài tiện ích DropshipHub cho Chrome.",
  "suppliers.extension.step2": "Tạo token cho tiện ích trong Cài đặt → Nâng cao rồi dán vào tiện ích.",
  "suppliers.extension.step3": "Mở một sản phẩm trên AliExpress và bấm \"Add to DropshipHub\".",
  "suppliers.extension.settingsLink": "Lấy token trong Cài đặt → Nâng cao",

  "suppliers.modal.title": "Thêm nhà cung cấp",
  "suppliers.modal.platform": "Nhà cung cấp",
  "suppliers.modal.platformHelp": "Tài khoản này thuộc nền tảng nào.",
  "suppliers.modal.needsApiKeys": "Chưa dùng được: máy chủ chưa cấu hình API key của nền tảng này.",
  "suppliers.modal.oauthHelp": "Bạn sẽ được chuyển sang trang nhà cung cấp để cho phép truy cập, rồi quay lại đây.",
  "suppliers.modal.capabilities": "Nhà cung cấp này làm được gì",

  "suppliers.disconnect.title": "Ngắt kết nối {label}?",
  "suppliers.disconnect.body": "Đơn cho nhà cung cấp này sẽ ngừng được đặt cho tới khi có tài khoản khác được kết nối. Bạn có thể kết nối lại bất cứ lúc nào.",
};
