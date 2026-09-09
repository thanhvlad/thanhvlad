/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 */
export const en = {
  // ---- Pricing: page --------------------------------------------------------
  "pricing.addRule": "Add rule",
  "pricing.stat.rules": "Pricing rules",
  "pricing.stat.enabled": "Enabled",
  "pricing.stat.default": "Default for new imports",
  "pricing.stat.builtIn": "Built-in default",
  "pricing.stat.builtInHint": "2× cost, compare-at 1.4×, .99 ending",
  "pricing.stat.applied": "Products priced by a rule",

  // ---- Pricing: table -------------------------------------------------------
  "pricing.resource.singular": "rule",
  "pricing.resource.plural": "rules",
  "pricing.table.name": "Rule",
  "pricing.table.formula": "Formula",
  "pricing.table.appliesTo": "Applies to",
  "pricing.table.appliesTo.product": "1 product",
  "pricing.table.appliesTo.products": "{n} products",
  "pricing.table.appliesTo.newImports": "New imports",
  "pricing.emptyState.heading": "No pricing rule yet",

  // ---- Pricing: modal -------------------------------------------------------
  "pricing.form.guards": "Rounding and limits",
  "pricing.preview.help": "How this rule prices a few sample costs, assuming {shipping} supplier shipping.",

  // ---- Pricing: confirm delete ---------------------------------------------
  "pricing.delete.title": "Delete {name}?",
  "pricing.delete.body": "Products already priced keep their current price. New imports that used this rule fall back to the default.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "pricing.addRule": "Thêm quy tắc",
  "pricing.stat.rules": "Quy tắc giá",
  "pricing.stat.enabled": "Đang bật",
  "pricing.stat.default": "Mặc định cho hàng nhập mới",
  "pricing.stat.builtIn": "Mặc định có sẵn",
  "pricing.stat.builtInHint": "2× giá vốn, giá so sánh 1.4×, đuôi .99",
  "pricing.stat.applied": "Sản phẩm đang áp quy tắc",

  "pricing.resource.singular": "quy tắc",
  "pricing.resource.plural": "quy tắc",
  "pricing.table.name": "Quy tắc",
  "pricing.table.formula": "Công thức",
  "pricing.table.appliesTo": "Áp dụng cho",
  "pricing.table.appliesTo.product": "1 sản phẩm",
  "pricing.table.appliesTo.products": "{n} sản phẩm",
  "pricing.table.appliesTo.newImports": "Hàng nhập mới",
  "pricing.emptyState.heading": "Chưa có quy tắc giá",

  "pricing.form.guards": "Làm tròn và giới hạn",
  "pricing.preview.help": "Quy tắc này định giá vài mức giá vốn mẫu ra sao, giả định phí ship nhà cung cấp là {shipping}.",

  "pricing.delete.title": "Xoá {name}?",
  "pricing.delete.body": "Sản phẩm đã định giá vẫn giữ giá hiện tại. Hàng nhập mới từng dùng quy tắc này sẽ dùng quy tắc mặc định.",
};
