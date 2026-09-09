/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 *
 * Older tracking keys (`tracking.tab.*`, `tracking.col.*`, …) still live in the
 * core dictionary; everything the redesigned screen added is here.
 */
export const en = {
  "tracking.subtitle": "Tracking numbers from suppliers, pushed to Shopify as fulfilments.",

  // ---- Stat strip -----------------------------------------------------------
  "tracking.stat.awaitingShipment": "Awaiting shipment",
  "tracking.stat.supplierOrders": "Supplier orders not yet shipped",
  "tracking.stat.notSyncedHint": "Waiting to be pushed to Shopify",
  "tracking.stat.failedHint": "Fix the order, then sync again",
  "tracking.stat.allSynced": "Everything is on Shopify",
  "tracking.stat.deliveredHint": "Of {n} tracking number(s)",

  // ---- Table ------------------------------------------------------------------
  "tracking.col.shopify": "Synced to Shopify",
  "tracking.sync.synced": "Synced",
  "tracking.sync.pending": "Not synced",
  "tracking.sync.failed": "Sync failed",
  "tracking.noStatusYet": "No update yet",
  "tracking.emptyTab": "Nothing in this tab",
  "tracking.emptyTabBody": "No tracking numbers match this filter.",
  "tracking.viewAll": "View all tracking",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "tracking.subtitle": "Mã vận đơn từ nhà cung cấp, được đẩy lên Shopify để fulfill đơn.",

  "tracking.stat.awaitingShipment": "Chờ gửi hàng",
  "tracking.stat.supplierOrders": "Đơn nhà cung cấp chưa gửi",
  "tracking.stat.notSyncedHint": "Đang chờ đẩy lên Shopify",
  "tracking.stat.failedHint": "Sửa đơn rồi đồng bộ lại",
  "tracking.stat.allSynced": "Tất cả đã lên Shopify",
  "tracking.stat.deliveredHint": "Trên tổng {n} mã vận đơn",

  "tracking.col.shopify": "Đồng bộ Shopify",
  "tracking.sync.synced": "Đã đồng bộ",
  "tracking.sync.pending": "Chưa đồng bộ",
  "tracking.sync.failed": "Đồng bộ lỗi",
  "tracking.noStatusYet": "Chưa có cập nhật",
  "tracking.emptyTab": "Không có mã nào ở mục này",
  "tracking.emptyTabBody": "Không có mã vận đơn nào khớp bộ lọc này.",
  "tracking.viewAll": "Xem tất cả vận đơn",
};
