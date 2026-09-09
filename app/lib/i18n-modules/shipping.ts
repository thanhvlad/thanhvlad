/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 */
export const en = {
  // ---- Shipping: page -------------------------------------------------------
  "shipping.addPreference": "Add preference",
  "shipping.editPreference": "Edit preference",
  "shipping.stat.destinations": "Destinations",
  "shipping.stat.destinationsHint": "including all other countries",
  "shipping.stat.carriers": "Preferred carriers",
  "shipping.stat.carriersHint": "{enabled} enabled",
  "shipping.stat.fallback": "When none match",
  "shipping.stat.fallback.CHEAPEST": "Cheapest method",
  "shipping.stat.fallback.FASTEST": "Fastest method",
  "shipping.stat.fallback.NONE": "Hold the order",
  "shipping.stat.maxCost": "Max shipping per order",
  "shipping.stat.noLimit": "No limit",

  // ---- Shipping: table ------------------------------------------------------
  "shipping.resource.singular": "preference",
  "shipping.resource.plural": "preferences",
  "shipping.table.destination": "Destination",
  "shipping.table.carrier": "Preferred carrier",
  "shipping.table.order": "Order of choice",
  "shipping.table.preferred": "Preferred",
  "shipping.table.fallback": "Fallback {n}",
  "shipping.table.maxCost": "Max cost",
  "shipping.table.maxDays": "Max days",
  "shipping.table.tracking": "Tracking",
  "shipping.table.trackingRequired": "Required",
  "shipping.table.trackingOptional": "Optional",
  "shipping.emptyState.heading": "No shipping preference yet",

  // ---- Shipping: modal ------------------------------------------------------
  "shipping.form.countryHelp": "Two-letter country code such as US or DE. Use * for every country without its own preference.",
  "shipping.form.priorityHelp": "Lower goes first. The first carrier that fits the limits below is used.",
  "shipping.form.maxCostHelp": "Skip this carrier when its quote is above this amount.",
  "shipping.form.maxDaysHelp": "Skip this carrier when it estimates more days than this.",

  // ---- Shipping: confirm remove --------------------------------------------
  "shipping.remove.title": "Remove {carrier} for {destination}?",
  "shipping.remove.body": "Orders to this destination will fall back to the global rule until you add another carrier.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "shipping.addPreference": "Thêm ưu tiên",
  "shipping.editPreference": "Sửa ưu tiên",
  "shipping.stat.destinations": "Thị trường",
  "shipping.stat.destinationsHint": "gồm cả nhóm các quốc gia còn lại",
  "shipping.stat.carriers": "Đơn vị vận chuyển ưu tiên",
  "shipping.stat.carriersHint": "{enabled} đang bật",
  "shipping.stat.fallback": "Khi không khớp",
  "shipping.stat.fallback.CHEAPEST": "Phương thức rẻ nhất",
  "shipping.stat.fallback.FASTEST": "Phương thức nhanh nhất",
  "shipping.stat.fallback.NONE": "Giữ đơn lại",
  "shipping.stat.maxCost": "Phí ship tối đa mỗi đơn",
  "shipping.stat.noLimit": "Không giới hạn",

  "shipping.resource.singular": "ưu tiên",
  "shipping.resource.plural": "ưu tiên",
  "shipping.table.destination": "Thị trường",
  "shipping.table.carrier": "Đơn vị vận chuyển ưu tiên",
  "shipping.table.order": "Thứ tự chọn",
  "shipping.table.preferred": "Ưu tiên",
  "shipping.table.fallback": "Dự phòng {n}",
  "shipping.table.maxCost": "Phí tối đa",
  "shipping.table.maxDays": "Số ngày tối đa",
  "shipping.table.tracking": "Vận đơn",
  "shipping.table.trackingRequired": "Bắt buộc",
  "shipping.table.trackingOptional": "Tuỳ chọn",
  "shipping.emptyState.heading": "Chưa có ưu tiên vận chuyển",

  "shipping.form.countryHelp": "Mã quốc gia 2 chữ như US hoặc DE. Dùng * cho mọi quốc gia chưa có ưu tiên riêng.",
  "shipping.form.priorityHelp": "Số nhỏ được chọn trước. Đơn vị đầu tiên thoả các giới hạn bên dưới sẽ được dùng.",
  "shipping.form.maxCostHelp": "Bỏ qua đơn vị này khi báo giá cao hơn mức này.",
  "shipping.form.maxDaysHelp": "Bỏ qua đơn vị này khi dự kiến giao lâu hơn số ngày này.",

  "shipping.remove.title": "Gỡ {carrier} cho {destination}?",
  "shipping.remove.body": "Đơn tới thị trường này sẽ dùng quy tắc chung cho tới khi bạn thêm đơn vị vận chuyển khác.",
};
