/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 *
 * Older payment keys (`payments.pay`, `payments.deadline`, …) still live in the
 * core dictionary; everything the redesigned screen added is here.
 */
export const en = {
  // ---- Stat strip -----------------------------------------------------------
  "payments.stat.unpaidTotal": "Unpaid total ({currency})",
  "payments.stat.unpaidOrders": "Unpaid orders",
  "payments.stat.oldest": "Oldest unpaid",
  "payments.stat.overdue": "Past deadline",
  "payments.stat.orders": "{n} order(s)",
  "payments.stat.dueSoon": "{n} due within 6 hours",
  "payments.stat.noneDueSoon": "None due within 6 hours",
  "payments.stat.noOverdue": "All within their deadline",
  "payments.stat.noDeadline": "No supplier deadline",

  // ---- Banners ----------------------------------------------------------------
  "payments.banner.overdue": "{n} order(s) are past their payment deadline",
  "payments.banner.dueSoon": "{n} order(s) must be paid within 6 hours",

  // ---- Tabs -------------------------------------------------------------------
  "payments.tab.overdue": "Overdue",

  // ---- Table ------------------------------------------------------------------
  "payments.col.order": "Order",
  "payments.col.placed": "Placed",
  "payments.col.actions": "Actions",
  "payments.emptyTab": "No orders in this tab",
  "payments.emptyTabBody": "Every unpaid supplier order is listed under All.",
  "payments.viewAllUnpaid": "View all unpaid",

  // ---- Actions ----------------------------------------------------------------
  "payments.openUnpaidListOn": "Open unpaid list on {platform}",
  "payments.checkSelected": "Check payment status",
  "payments.paySelected": "Pay on supplier site",
  "payments.markPaid": "Mark as paid",

  // ---- Action results (returned from the server as keys) ---------------------
  "payments.msg.checkedPaid": "{paid} of {checked} order(s) are now paid.",
  "payments.msg.checkedNone": "Checked {checked} order(s); none are paid yet.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "payments.stat.unpaidTotal": "Tổng chưa thanh toán ({currency})",
  "payments.stat.unpaidOrders": "Đơn chưa thanh toán",
  "payments.stat.oldest": "Đơn chờ lâu nhất",
  "payments.stat.overdue": "Quá hạn thanh toán",
  "payments.stat.orders": "{n} đơn",
  "payments.stat.dueSoon": "{n} đơn phải trả trong 6 giờ tới",
  "payments.stat.noneDueSoon": "Không có đơn nào sắp đến hạn",
  "payments.stat.noOverdue": "Tất cả vẫn trong hạn",
  "payments.stat.noDeadline": "Nhà cung cấp không đặt hạn",

  "payments.banner.overdue": "{n} đơn đã quá hạn thanh toán",
  "payments.banner.dueSoon": "{n} đơn phải thanh toán trong vòng 6 giờ",

  "payments.tab.overdue": "Quá hạn",

  "payments.col.order": "Đơn hàng",
  "payments.col.placed": "Đặt lúc",
  "payments.col.actions": "Thao tác",
  "payments.emptyTab": "Không có đơn nào ở mục này",
  "payments.emptyTabBody": "Mọi đơn nhà cung cấp chưa thanh toán đều nằm trong mục Tất cả.",
  "payments.viewAllUnpaid": "Xem tất cả đơn chưa trả",

  "payments.openUnpaidListOn": "Mở danh sách chưa trả trên {platform}",
  "payments.checkSelected": "Kiểm tra trạng thái thanh toán",
  "payments.paySelected": "Thanh toán trên trang nhà cung cấp",
  "payments.markPaid": "Đánh dấu đã trả",

  "payments.msg.checkedPaid": "{paid}/{checked} đơn đã được thanh toán.",
  "payments.msg.checkedNone": "Đã kiểm tra {checked} đơn; chưa đơn nào được thanh toán.",
};
