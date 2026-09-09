/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 */
export const en = {
  // ---- Page ---------------------------------------------------------------
  "inventory.subtitle": "Keeps your prices and stock in step with your suppliers.",

  // ---- Stat strip ---------------------------------------------------------
  "inventory.stat.lastRun": "Last run",
  "inventory.stat.never": "Never",
  "inventory.stat.checksEvery": "Checks every {n} minutes",
  "inventory.stat.autoOff": "Automatic sync is off",
  "inventory.stat.onAutoUpdate": "Products on auto-update",
  "inventory.stat.ofTotal": "of {n} products",
  "inventory.stat.checked": "Products checked",
  "inventory.stat.changes": "Changes applied",
  "inventory.stat.inLastRun": "in the last run",
  "inventory.stat.changesHint": "{price} price · {stock} stock · {unpublished} unpublished",
  "inventory.stat.suppliersRefreshed": "Suppliers refreshed",

  // ---- Policy form --------------------------------------------------------
  "inventory.policy.help": "What to do when a supplier changes a price, runs out of stock or removes a product.",
  "inventory.enabledHelp": "When off, nothing is checked or changed — scheduled and manual runs do nothing.",
  "inventory.form.priceRules": "Price changes",
  "inventory.form.stockRules": "Stock changes",
  "inventory.form.schedule": "Schedule",

  // ---- Dry run ------------------------------------------------------------
  "inventory.dryRun.help": "Nothing was changed. This is what the next run would do with the current policy.",
  "inventory.dryRun.nothing": "Nothing would change",
  "inventory.dryRun.nothingBody": "Your store already matches your suppliers under the current policy.",
  "inventory.dryRun.truncated": "Showing the first {n} of {total} changes.",
  "inventory.table.newPrice": "New price",
  "inventory.table.newQuantity": "New quantity",
  "inventory.actionType.UPDATE_PRICE": "Update price",
  "inventory.actionType.UPDATE_INVENTORY": "Update stock",
  "inventory.actionType.UNPUBLISH_PRODUCT": "Unpublish product",
  "inventory.actionType.UPDATE_COST": "Update cost",
  "inventory.actionType.NOTIFY": "Notify only",

  // ---- Recent runs --------------------------------------------------------
  "inventory.runs.started": "Started",
  "inventory.runs.duration": "Duration",
  "inventory.runs.checked": "Checked",
  "inventory.runs.priceUpdates": "Price updates",
  "inventory.runs.stockUpdates": "Stock updates",
  "inventory.runs.unpublished": "Unpublished",
  "inventory.runs.suppliersFailed": "Suppliers failed",
  "inventory.runs.notes": "Notes",
  "inventory.runs.seconds": "{n}s",
  "inventory.runs.minutes": "{n} min",
  "inventory.runs.empty.heading": "No runs yet",
  "inventory.runs.empty.body": "Run the auto-update once to see what it checks and what it changes.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "inventory.subtitle": "Giữ giá bán và tồn kho của bạn luôn khớp với nhà cung cấp.",

  "inventory.stat.lastRun": "Lần chạy gần nhất",
  "inventory.stat.never": "Chưa chạy",
  "inventory.stat.checksEvery": "Kiểm tra mỗi {n} phút",
  "inventory.stat.autoOff": "Đang tắt đồng bộ tự động",
  "inventory.stat.onAutoUpdate": "Sản phẩm đang tự động cập nhật",
  "inventory.stat.ofTotal": "trên tổng {n} sản phẩm",
  "inventory.stat.checked": "Sản phẩm đã kiểm tra",
  "inventory.stat.changes": "Thay đổi đã áp dụng",
  "inventory.stat.inLastRun": "ở lần chạy gần nhất",
  "inventory.stat.changesHint": "{price} giá · {stock} tồn kho · {unpublished} đã ẩn",
  "inventory.stat.suppliersRefreshed": "Nhà cung cấp đã làm mới",

  "inventory.policy.help": "Cách xử lý khi nhà cung cấp đổi giá, hết hàng hoặc gỡ sản phẩm.",
  "inventory.enabledHelp": "Khi tắt, app không kiểm tra hay thay đổi gì — chạy theo lịch lẫn chạy tay đều bỏ qua.",
  "inventory.form.priceRules": "Thay đổi giá",
  "inventory.form.stockRules": "Thay đổi tồn kho",
  "inventory.form.schedule": "Lịch chạy",

  "inventory.dryRun.help": "Chưa có gì bị thay đổi. Đây là những gì lần chạy tiếp theo sẽ làm với chính sách hiện tại.",
  "inventory.dryRun.nothing": "Không có gì thay đổi",
  "inventory.dryRun.nothingBody": "Cửa hàng của bạn đã khớp với nhà cung cấp theo chính sách hiện tại.",
  "inventory.dryRun.truncated": "Đang hiện {n} trên {total} thay đổi đầu tiên.",
  "inventory.table.newPrice": "Giá mới",
  "inventory.table.newQuantity": "Số lượng mới",
  "inventory.actionType.UPDATE_PRICE": "Cập nhật giá",
  "inventory.actionType.UPDATE_INVENTORY": "Cập nhật tồn kho",
  "inventory.actionType.UNPUBLISH_PRODUCT": "Ẩn sản phẩm",
  "inventory.actionType.UPDATE_COST": "Cập nhật giá vốn",
  "inventory.actionType.NOTIFY": "Chỉ thông báo",

  "inventory.runs.started": "Bắt đầu",
  "inventory.runs.duration": "Thời gian chạy",
  "inventory.runs.checked": "Đã kiểm tra",
  "inventory.runs.priceUpdates": "Cập nhật giá",
  "inventory.runs.stockUpdates": "Cập nhật tồn kho",
  "inventory.runs.unpublished": "Đã ẩn",
  "inventory.runs.suppliersFailed": "Nhà cung cấp lỗi",
  "inventory.runs.notes": "Ghi chú",
  "inventory.runs.seconds": "{n} giây",
  "inventory.runs.minutes": "{n} phút",
  "inventory.runs.empty.heading": "Chưa có lần chạy nào",
  "inventory.runs.empty.body": "Chạy tự động cập nhật một lần để xem app kiểm tra và thay đổi những gì.",
};
