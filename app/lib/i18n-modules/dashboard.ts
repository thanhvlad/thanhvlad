/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 *
 * The older dashboard keys (`dashboard.onboarding.*`, `dashboard.stat.*`,
 * `dashboard.quick.*`) still live in the core dictionary; the keys here are the
 * ones the redesigned home screen added on top of them. Sentences carry
 * `{placeholders}` rather than being glued together at the call site, so the
 * Vietnamese can put the number where Vietnamese puts it.
 */
export const en = {
  // ---- Page ---------------------------------------------------------------
  "dashboard.subtitle": "How the store did this week, where work is waiting, and what to do next.",
  "dashboard.actions.sync": "Sync",
  "dashboard.actions.syncOrders.hint": "Pull the last 30 days of orders from Shopify",
  "dashboard.actions.checkSupplierOrders.hint": "Refresh payment and shipping status from your suppliers",
  "dashboard.jobsRunning": "{n} background job(s) running",

  // ---- Onboarding checklist ----------------------------------------------
  "dashboard.onboarding.progress": "{done} of {total} steps done",
  "dashboard.onboarding.next": "Up next",
  "dashboard.onboarding.supplier.hint": "Orders can only be placed through a connected AliExpress or CJ account.",
  "dashboard.onboarding.pricing.hint": "Sets the selling price from the supplier cost, so every import is priced the same way.",
  "dashboard.onboarding.shipping.hint": "Which shipping method to pick for each destination when an order is placed.",
  "dashboard.onboarding.fulfillmentService.hint": "Lets Shopify hand new orders to the app instead of waiting for you.",
  "dashboard.onboarding.product.hint": "Find a product, push it to your store, and it shows up under My products.",
  "dashboard.onboarding.order.hint": "Your first synced order lands in the pipeline below, ready to place.",

  // ---- Stat strip ---------------------------------------------------------
  "dashboard.stat.margin": "{percent} margin",
  "dashboard.stat.failedHint": "{n} failed at the supplier",
  "dashboard.stat.unmappedHint": "{n} without a supplier",
  "dashboard.stat.allMapped": "All mapped to a supplier",

  // ---- Pipeline -----------------------------------------------------------
  "dashboard.pipeline.failed": "{n} order(s) failed at the supplier.",

  // ---- Needs attention ----------------------------------------------------
  "dashboard.attention.urgent": "Urgent",
  "dashboard.attention.warning": "Warning",

  // ---- Quick actions ------------------------------------------------------
  "dashboard.quick.findImport.hint": "Search AliExpress and CJ, or paste a product link",
  "dashboard.quick.reviewImportList.hint": "Check price, variants and images before pushing to your store",
  "dashboard.quick.placeReady": "Place ready orders",
  "dashboard.quick.placeReady.hint": "Send paid Shopify orders to the supplier",
  "dashboard.quick.runAutoUpdate.hint": "Re-check supplier prices and stock for every managed product",
  "dashboard.quick.openReports.hint": "Revenue, supplier cost and profit by day",

  // ---- Plan ---------------------------------------------------------------
  "dashboard.plan.manage": "Manage plan",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "dashboard.subtitle": "Tuần này cửa hàng bán ra sao, việc nào đang chờ và nên làm gì tiếp theo.",
  "dashboard.actions.sync": "Đồng bộ",
  "dashboard.actions.syncOrders.hint": "Lấy đơn hàng 30 ngày gần nhất từ Shopify",
  "dashboard.actions.checkSupplierOrders.hint": "Cập nhật trạng thái thanh toán và vận chuyển từ nhà cung cấp",
  "dashboard.jobsRunning": "{n} tác vụ nền đang chạy",

  "dashboard.onboarding.progress": "Xong {done}/{total} bước",
  "dashboard.onboarding.next": "Bước tiếp theo",
  "dashboard.onboarding.supplier.hint": "Chỉ đặt được đơn khi đã kết nối tài khoản AliExpress hoặc CJ.",
  "dashboard.onboarding.pricing.hint": "Tự tính giá bán từ giá nhập, để mọi sản phẩm nhập về đều được định giá theo cùng một cách.",
  "dashboard.onboarding.shipping.hint": "Chọn sẵn phương thức vận chuyển cho từng quốc gia khi đặt đơn.",
  "dashboard.onboarding.fulfillmentService.hint": "Để Shopify tự chuyển đơn mới sang app thay vì chờ bạn bấm tay.",
  "dashboard.onboarding.product.hint": "Tìm một sản phẩm, đẩy lên cửa hàng, sản phẩm sẽ nằm trong mục Sản phẩm của tôi.",
  "dashboard.onboarding.order.hint": "Đơn đầu tiên đồng bộ về sẽ hiện trong luồng xử lý bên dưới, sẵn sàng để đặt.",

  "dashboard.stat.margin": "Biên lợi nhuận {percent}",
  "dashboard.stat.failedHint": "{n} đơn lỗi ở nhà cung cấp",
  "dashboard.stat.unmappedHint": "{n} sản phẩm chưa có nhà cung cấp",
  "dashboard.stat.allMapped": "Tất cả đã ghép nhà cung cấp",

  "dashboard.pipeline.failed": "{n} đơn bị lỗi ở nhà cung cấp.",

  "dashboard.attention.urgent": "Khẩn",
  "dashboard.attention.warning": "Cảnh báo",

  "dashboard.quick.findImport.hint": "Tìm trên AliExpress và CJ, hoặc dán link sản phẩm",
  "dashboard.quick.reviewImportList.hint": "Kiểm tra giá, biến thể và hình ảnh trước khi đẩy lên cửa hàng",
  "dashboard.quick.placeReady": "Đặt các đơn đã sẵn sàng",
  "dashboard.quick.placeReady.hint": "Gửi đơn Shopify đã thanh toán sang nhà cung cấp",
  "dashboard.quick.runAutoUpdate.hint": "Kiểm tra lại giá và tồn kho nhà cung cấp cho mọi sản phẩm đang quản lý",
  "dashboard.quick.openReports.hint": "Doanh thu, giá nhập và lợi nhuận theo ngày",

  "dashboard.plan.manage": "Quản lý gói",
};
