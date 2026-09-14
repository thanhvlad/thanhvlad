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
 *
 * Copy here describes what production does today. Products come in through the
 * Chrome extension on the AliExpress page. Orders are placed and paid for by the
 * merchant on AliExpress: the extension lists the orders waiting, opens each
 * product and records the AliExpress order number and tracking, but it never
 * places or pays for an order by itself, and the copy must not say it does. The
 * ordering sentence is the same one the orders screens, the support page and the
 * terms use, so the four places cannot drift apart. The welcome banner and hints
 * used to send merchants to "Connect AliExpress" and to search AliExpress through
 * an API that is not switched on, which a reviewer following them could not
 * complete; `dashboard.welcome.body` overrides the older core wording for that
 * reason.
 */
export const en = {
  // ---- Page ---------------------------------------------------------------
  "dashboard.subtitle": "How the store did this week, where work is waiting, and what to do next.",
  "dashboard.actions.sync": "Sync",
  "dashboard.actions.syncOrders.hint": "Pull the last 30 days of orders from Shopify",
  "dashboard.actions.checkSupplierOrders.hint": "Refresh payment and shipping status from your suppliers",
  "dashboard.jobsRunning": "{n} background job(s) running",
  "dashboard.welcome.body": "Install the DropshipHub Chrome extension, open a product on AliExpress and add it to your import list, then set a pricing rule before you push it to your store. The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify. Orders from the last 30 days are being synced in the background.",

  // ---- Onboarding checklist ----------------------------------------------
  "dashboard.onboarding.progress": "{done} of {total} steps done",
  "dashboard.onboarding.next": "Up next",
  "dashboard.onboarding.supplier.hint": "Optional today: no connected account is needed. Products are imported with the Chrome extension, and you place and pay for each AliExpress order on AliExpress yourself.",
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
  "dashboard.quick.findImport.hint": "Open a product on AliExpress and add it with the Chrome extension",
  "dashboard.quick.reviewImportList.hint": "Check price, variants and images before pushing to your store",
  "dashboard.quick.placeReady": "Place ready orders",
  "dashboard.quick.placeReady.hint": "Paid orders waiting for you to place them on AliExpress",
  "dashboard.quick.runAutoUpdate.hint": "Re-check supplier prices and stock for every managed product",
  "dashboard.quick.openReports.hint": "Revenue, supplier cost and profit by day",

  // ---- Plan ---------------------------------------------------------------
  "dashboard.plan.manage": "Manage plan",
  "dashboard.sync.alreadyRunning": "A sync is already running.",
  "dashboard.sync.supplierAlreadyRunning": "A supplier check is already running.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "dashboard.subtitle": "Tuần này cửa hàng bán ra sao, việc nào đang chờ và nên làm gì tiếp theo.",
  "dashboard.actions.sync": "Đồng bộ",
  "dashboard.actions.syncOrders.hint": "Lấy đơn hàng 30 ngày gần nhất từ Shopify",
  "dashboard.actions.checkSupplierOrders.hint": "Cập nhật trạng thái thanh toán và vận chuyển từ nhà cung cấp",
  "dashboard.jobsRunning": "{n} tác vụ nền đang chạy",
  "dashboard.welcome.body": "Cài tiện ích DropshipHub cho Chrome, mở một sản phẩm trên AliExpress và thêm vào danh sách nhập, rồi đặt quy tắc giá trước khi đẩy lên cửa hàng. Tiện ích Chrome liệt kê các đơn đang chờ đặt và mở từng sản phẩm trên AliExpress. Bạn tự đặt và thanh toán đơn ngay trên AliExpress, rồi ghi mã đơn AliExpress vào tiện ích; mã vận đơn bạn thêm ở đó sẽ được gửi sang Shopify. Đơn hàng 30 ngày gần nhất đang được đồng bộ ngầm.",

  "dashboard.onboarding.progress": "Xong {done}/{total} bước",
  "dashboard.onboarding.next": "Bước tiếp theo",
  "dashboard.onboarding.supplier.hint": "Hiện chưa bắt buộc: không cần kết nối tài khoản. Sản phẩm được nhập bằng tiện ích Chrome, còn từng đơn AliExpress thì bạn tự đặt và thanh toán trên AliExpress.",
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

  "dashboard.quick.findImport.hint": "Mở sản phẩm trên AliExpress và thêm bằng tiện ích Chrome",
  "dashboard.quick.reviewImportList.hint": "Kiểm tra giá, biến thể và hình ảnh trước khi đẩy lên cửa hàng",
  "dashboard.quick.placeReady": "Đặt các đơn đã sẵn sàng",
  "dashboard.quick.placeReady.hint": "Đơn đã thanh toán đang chờ bạn đặt trên AliExpress",
  "dashboard.quick.runAutoUpdate.hint": "Kiểm tra lại giá và tồn kho nhà cung cấp cho mọi sản phẩm đang quản lý",
  "dashboard.quick.openReports.hint": "Doanh thu, giá nhập và lợi nhuận theo ngày",

  "dashboard.plan.manage": "Quản lý gói",
  "dashboard.sync.alreadyRunning": "Đang có một lượt đồng bộ chạy rồi.",
  "dashboard.sync.supplierAlreadyRunning": "Đang có một lượt kiểm tra nhà cung cấp chạy rồi.",
};
