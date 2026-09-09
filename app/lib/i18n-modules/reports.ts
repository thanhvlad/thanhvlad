/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 */
export const en = {
  // ---- Stat strip ---------------------------------------------------------
  "reports.stat.revenueHint": "{orders} orders · {items} items",
  "reports.stat.profitHint": "{fulfilled} fulfilled · {failed} failed",
  "reports.stat.margin": "Margin",
  "reports.stat.marginHint": "Profit as a share of revenue",

  // ---- Tables -------------------------------------------------------------
  "reports.byDay.title": "By day",
  "reports.byDay.help": "Most recent day first. Longer ranges show the last {n} days here; the figures above cover the whole range.",
  "reports.chart.help": "One pair of bars per day.",

  // ---- Empty states -------------------------------------------------------
  "reports.empty.heading": "No sales data for this period",
  "reports.topProducts.empty.heading": "No products sold",
  "reports.destinations.empty.heading": "No destinations yet",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "reports.stat.revenueHint": "{orders} đơn · {items} sản phẩm",
  "reports.stat.profitHint": "{fulfilled} đã giao · {failed} lỗi",
  "reports.stat.margin": "Biên lợi nhuận",
  "reports.stat.marginHint": "Lợi nhuận trên doanh thu",

  "reports.byDay.title": "Theo ngày",
  "reports.byDay.help": "Ngày mới nhất ở trên. Khoảng dài hơn chỉ hiện {n} ngày gần nhất ở đây; các con số phía trên tính cho cả khoảng.",
  "reports.chart.help": "Mỗi ngày một cặp cột.",

  "reports.empty.heading": "Chưa có dữ liệu bán hàng cho khoảng này",
  "reports.topProducts.empty.heading": "Chưa bán được sản phẩm nào",
  "reports.destinations.empty.heading": "Chưa có nơi giao hàng",
};
