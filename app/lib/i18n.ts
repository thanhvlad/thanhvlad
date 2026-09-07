/**
 * Lightweight i18n. English is the source of truth; Vietnamese covers the
 * navigation, statuses and common actions. Add keys here and in `vi` to
 * extend coverage — missing keys fall back to English.
 */
export type Locale = "en" | "vi";

const en = {
  "nav.home": "Home",
  "nav.search": "Find products",
  "nav.import": "Import list",
  "nav.products": "My products",
  "nav.orders": "Orders",
  "nav.tracking": "Tracking",
  "nav.suppliers": "Suppliers",
  "nav.pricing": "Pricing rules",
  "nav.shipping": "Shipping",
  "nav.inventory": "Auto updates",
  "nav.reports": "Reports",
  "nav.notifications": "Notifications",
  "nav.logs": "Activity",
  "nav.settings": "Settings",

  "stage.PENDING": "Pending",
  "stage.AWAITING_ORDER": "Awaiting order",
  "stage.AWAITING_PAYMENT": "Awaiting payment",
  "stage.AWAITING_SHIPMENT": "Awaiting shipment",
  "stage.AWAITING_DELIVERY": "Awaiting delivery",
  "stage.FULFILLED": "Fulfilled",
  "stage.CANCELED": "Canceled",
  "stage.FAILED": "Failed",

  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.delete": "Delete",
  "action.push": "Push to Shopify",
  "action.placeOrder": "Place order",
  "action.placeOrders": "Place orders",
  "action.sync": "Sync now",
  "action.retry": "Retry",
  "action.addToImport": "Add to import list",
  "action.search": "Search",

  "common.loading": "Loading…",
  "common.none": "None",
  "common.all": "All",
} as const;

export type I18nKey = keyof typeof en;

const vi: Partial<Record<I18nKey, string>> = {
  "nav.home": "Trang chủ",
  "nav.search": "Tìm sản phẩm",
  "nav.import": "Danh sách nhập",
  "nav.products": "Sản phẩm của tôi",
  "nav.orders": "Đơn hàng",
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

  "action.save": "Lưu",
  "action.cancel": "Hủy",
  "action.delete": "Xóa",
  "action.push": "Đẩy lên Shopify",
  "action.placeOrder": "Đặt hàng",
  "action.placeOrders": "Đặt hàng hàng loạt",
  "action.sync": "Đồng bộ ngay",
  "action.retry": "Thử lại",
  "action.addToImport": "Thêm vào danh sách nhập",
  "action.search": "Tìm kiếm",

  "common.loading": "Đang tải…",
  "common.none": "Không có",
  "common.all": "Tất cả",
};

const dictionaries: Record<Locale, Partial<Record<I18nKey, string>>> = { en, vi };

export function translate(locale: Locale, key: I18nKey): string {
  return dictionaries[locale]?.[key] ?? en[key];
}

export function makeT(locale: Locale) {
  return (key: I18nKey) => translate(locale, key);
}

export const SUPPORTED_LOCALES: Array<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];
