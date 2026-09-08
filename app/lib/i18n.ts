/**
 * Lightweight i18n.
 *
 * English is the source of truth and always complete; Vietnamese covers the
 * navigation, page headings, order/payment vocabulary and the actions a merchant
 * uses daily. A missing key falls back to English rather than showing a blank,
 * so a partial translation is always safe to ship.
 *
 * Add a key to `en`, then to `vi`. `npm run typecheck` will not let a key exist
 * in `vi` that is missing from `en`.
 */
export type Locale = "en" | "vi";

const en = {
  // ---- Navigation ---------------------------------------------------------
  "nav.home": "Home",
  "nav.search": "Find products",
  "nav.import": "Import list",
  "nav.products": "My products",
  "nav.orders": "Orders",
  "nav.payments": "Payments",
  "nav.tracking": "Tracking",
  "nav.suppliers": "Suppliers",
  "nav.pricing": "Pricing rules",
  "nav.shipping": "Shipping",
  "nav.inventory": "Auto updates",
  "nav.reports": "Reports",
  "nav.notifications": "Notifications",
  "nav.logs": "Activity",
  "nav.settings": "Settings",

  // ---- Order pipeline -----------------------------------------------------
  "stage.PENDING": "Pending",
  "stage.AWAITING_ORDER": "Awaiting order",
  "stage.AWAITING_PAYMENT": "Awaiting payment",
  "stage.AWAITING_SHIPMENT": "Awaiting shipment",
  "stage.AWAITING_DELIVERY": "Awaiting delivery",
  "stage.FULFILLED": "Fulfilled",
  "stage.CANCELED": "Canceled",
  "stage.FAILED": "Failed",
  "stage.IGNORED": "Not ours",

  // ---- Actions ------------------------------------------------------------
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.delete": "Delete",
  "action.remove": "Remove",
  "action.push": "Push to Shopify",
  "action.addToShop": "Add to shop",
  "action.import": "Import",
  "action.placeOrder": "Place supplier order",
  "action.placeOrders": "Place orders",
  "action.pay": "Pay on supplier site",
  "action.checkPayment": "Check payment status",
  "action.markPaid": "Mark as paid",
  "action.sync": "Sync now",
  "action.retry": "Retry",
  "action.addToImport": "Add to import list",
  "action.search": "Search",
  "action.connect": "Connect",
  "action.reconnect": "Reconnect",
  "action.test": "Test",
  "action.autoMap": "Auto-map",
  "action.matchWithAi": "Match with AI",
  "action.compareSuppliers": "Find cheaper suppliers",
  "action.switchSupplier": "Switch",
  "action.export": "Export CSV",

  // ---- Page headings ------------------------------------------------------
  "page.dashboard.title": "Welcome",
  "page.dashboard.subtitle": "Dropshipping automation for AliExpress, CJ and more.",
  "page.search.title": "Find products",
  "page.search.subtitle": "Search supplier catalogs or paste product links to import.",
  "page.import.title": "Import list",
  "page.import.subtitle": "Review and edit products before they go to your store.",
  "page.products.title": "My products",
  "page.orders.title": "Orders",
  "page.payments.title": "Payments",
  "page.payments.subtitle": "Supplier orders are paid on the supplier's own site. Open them here, then confirm.",
  "page.tracking.title": "Tracking",
  "page.suppliers.title": "Suppliers",
  "page.suppliers.subtitle": "Connect the accounts used to search catalogs and place orders.",
  "page.pricing.title": "Pricing rules",
  "page.pricing.subtitle": "Turn supplier costs into store prices automatically.",
  "page.shipping.title": "Shipping",
  "page.shipping.subtitle": "Which supplier shipping method to pick for each destination.",
  "page.inventory.title": "Auto updates",
  "page.reports.title": "Reports",
  "page.notifications.title": "Notifications",
  "page.logs.title": "Activity",
  "page.settings.title": "Settings",

  // ---- Payments -----------------------------------------------------------
  "payments.outstanding": "Outstanding",
  "payments.deadline": "Deadline",
  "payments.overdue": "Overdue",
  "payments.hoursLeft": "hours left",
  "payments.openUnpaidList": "Open unpaid list",
  "payments.empty": "Nothing to pay",
  "payments.autoCancelWarning": "AliExpress cancels unpaid orders after 24 hours.",

  // ---- Common -------------------------------------------------------------
  "common.loading": "Loading…",
  "common.none": "None",
  "common.all": "All",
  "common.total": "Total",
  "common.cost": "Cost",
  "common.price": "Price",
  "common.profit": "Profit",
  "common.revenue": "Revenue",
  "common.shipping": "Shipping",
  "common.supplier": "Supplier",
  "common.variants": "Variants",
  "common.stock": "Stock",
  "common.status": "Status",
  "common.customer": "Customer",
  "common.notMapped": "Not mapped",
  "common.outOfStock": "Out of stock",
  "common.inStock": "In stock",
  "common.needsAttention": "Needs attention",
} as const;

export type I18nKey = keyof typeof en;

const vi: Partial<Record<I18nKey, string>> = {
  "nav.home": "Trang chủ",
  "nav.search": "Tìm sản phẩm",
  "nav.import": "Danh sách nhập",
  "nav.products": "Sản phẩm của tôi",
  "nav.orders": "Đơn hàng",
  "nav.payments": "Thanh toán",
  "nav.tracking": "Vận đơn",
  "nav.suppliers": "Nhà cung cấp",
  "nav.pricing": "Quy tắc giá",
  "nav.shipping": "Vận chuyển",
  "nav.inventory": "Tự động cập nhật",
  "nav.reports": "Báo cáo",
  "nav.notifications": "Thông báo",
  "nav.logs": "Nhật ký",
  "nav.settings": "Cài đặt",

  "stage.PENDING": "Chờ xử lý",
  "stage.AWAITING_ORDER": "Chờ đặt hàng",
  "stage.AWAITING_PAYMENT": "Chờ thanh toán",
  "stage.AWAITING_SHIPMENT": "Chờ giao hàng",
  "stage.AWAITING_DELIVERY": "Đang vận chuyển",
  "stage.FULFILLED": "Hoàn tất",
  "stage.CANCELED": "Đã hủy",
  "stage.FAILED": "Thất bại",
  "stage.IGNORED": "Không thuộc app",

  "action.save": "Lưu",
  "action.cancel": "Hủy",
  "action.delete": "Xóa",
  "action.remove": "Gỡ bỏ",
  "action.push": "Đẩy lên Shopify",
  "action.addToShop": "Thêm vào shop",
  "action.import": "Nhập",
  "action.placeOrder": "Đặt hàng nhà cung cấp",
  "action.placeOrders": "Đặt hàng hàng loạt",
  "action.pay": "Thanh toán trên trang nhà cung cấp",
  "action.checkPayment": "Kiểm tra trạng thái thanh toán",
  "action.markPaid": "Đánh dấu đã trả",
  "action.sync": "Đồng bộ ngay",
  "action.retry": "Thử lại",
  "action.addToImport": "Thêm vào danh sách nhập",
  "action.search": "Tìm kiếm",
  "action.connect": "Kết nối",
  "action.reconnect": "Kết nối lại",
  "action.test": "Kiểm tra",
  "action.autoMap": "Tự động ghép",
  "action.matchWithAi": "Ghép bằng AI",
  "action.compareSuppliers": "Tìm nhà cung cấp rẻ hơn",
  "action.switchSupplier": "Chuyển sang",
  "action.export": "Xuất CSV",

  "page.dashboard.title": "Xin chào",
  "page.dashboard.subtitle": "Tự động hóa dropshipping cho AliExpress, CJ và các nguồn khác.",
  "page.search.title": "Tìm sản phẩm",
  "page.search.subtitle": "Tìm trong catalog nhà cung cấp hoặc dán link sản phẩm để nhập.",
  "page.import.title": "Danh sách nhập",
  "page.import.subtitle": "Xem lại và chỉnh sửa sản phẩm trước khi đưa lên cửa hàng.",
  "page.products.title": "Sản phẩm của tôi",
  "page.orders.title": "Đơn hàng",
  "page.payments.title": "Thanh toán",
  "page.payments.subtitle": "Đơn nhà cung cấp được thanh toán trên chính trang của họ. Mở tại đây rồi xác nhận.",
  "page.tracking.title": "Vận đơn",
  "page.suppliers.title": "Nhà cung cấp",
  "page.suppliers.subtitle": "Kết nối tài khoản dùng để tìm sản phẩm và đặt hàng.",
  "page.pricing.title": "Quy tắc giá",
  "page.pricing.subtitle": "Tự động chuyển giá vốn nhà cung cấp thành giá bán.",
  "page.shipping.title": "Vận chuyển",
  "page.shipping.subtitle": "Chọn phương thức vận chuyển của nhà cung cấp cho từng thị trường.",
  "page.inventory.title": "Tự động cập nhật",
  "page.reports.title": "Báo cáo",
  "page.notifications.title": "Thông báo",
  "page.logs.title": "Nhật ký",
  "page.settings.title": "Cài đặt",

  "payments.outstanding": "Còn phải trả",
  "payments.deadline": "Hạn chót",
  "payments.overdue": "Quá hạn",
  "payments.hoursLeft": "giờ nữa",
  "payments.openUnpaidList": "Mở danh sách chưa trả",
  "payments.empty": "Không có đơn nào cần thanh toán",
  "payments.autoCancelWarning": "AliExpress hủy đơn chưa thanh toán sau 24 giờ.",

  "common.loading": "Đang tải…",
  "common.none": "Không có",
  "common.all": "Tất cả",
  "common.total": "Tổng",
  "common.cost": "Giá vốn",
  "common.price": "Giá bán",
  "common.profit": "Lợi nhuận",
  "common.revenue": "Doanh thu",
  "common.shipping": "Phí vận chuyển",
  "common.supplier": "Nhà cung cấp",
  "common.variants": "Biến thể",
  "common.stock": "Tồn kho",
  "common.status": "Trạng thái",
  "common.customer": "Khách hàng",
  "common.notMapped": "Chưa ghép",
  "common.outOfStock": "Hết hàng",
  "common.inStock": "Còn hàng",
  "common.needsAttention": "Cần xử lý",
};

const dictionaries: Record<Locale, Partial<Record<I18nKey, string>>> = { en, vi };

export function translate(locale: Locale, key: I18nKey): string {
  return dictionaries[locale]?.[key] ?? en[key];
}

export function makeT(locale: Locale) {
  return (key: I18nKey) => translate(locale, key);
}

export type Translator = ReturnType<typeof makeT>;

export const SUPPORTED_LOCALES: Array<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

/** Coverage of a locale, used by the settings page to be honest about it. */
export function localeCoverage(locale: Locale): { translated: number; total: number; percent: number } {
  const total = Object.keys(en).length;
  const translated = Object.keys(dictionaries[locale] ?? {}).length;
  return { translated, total, percent: Math.round((translated / total) * 100) };
}
