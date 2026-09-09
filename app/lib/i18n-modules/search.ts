/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 */
export const en = {
  // ---- Page header --------------------------------------------------------
  "search.page.viewImportList": "Open import list",
  "search.page.extension": "Chrome extension",

  // ---- Search form --------------------------------------------------------
  "search.form.query": "Keyword or product name",
  "search.form.imagePlaceholder": "https://…/photo.jpg",

  // ---- Before the first search --------------------------------------------
  "search.start.heading": "Two ways to bring products in",
  "search.start.body":
    "Search a supplier catalog here and add what you like to the import list, or use the Chrome extension to add any AliExpress product straight from its page.",
  "search.start.action": "Set up the Chrome extension",

  // ---- Results ------------------------------------------------------------
  "search.results.count": "{count} results for “{query}”",
  "search.results.countUnknown": "Results for “{query}”",
  "search.results.page": "Page {page}",
  "search.results.empty.heading": "No products for “{query}”",
  "search.results.empty.body": "Try another keyword, switch supplier, or paste a product link below.",
  "search.results.empty.action": "Clear search",

  // ---- Product card -------------------------------------------------------
  "search.card.added": "Added to import list",
  "search.card.viewSource": "View on supplier site",
  "search.card.orders": "{count} orders",
  "search.card.noStats": "No ratings yet",
  "search.card.shipping": "+ {amount} shipping",
  "search.card.eta": "~{days} days",
  "search.card.noImage": "No image",

  // ---- Import by link -----------------------------------------------------
  "search.bulk.placeholder": "https://www.aliexpress.com/item/1005006001.html\n1005006002",
  "search.bulk.summary": "{ok} of {total} added to the import list",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "search.page.viewImportList": "Mở danh sách nhập",
  "search.page.extension": "Tiện ích Chrome",

  "search.form.query": "Từ khóa hoặc tên sản phẩm",
  "search.form.imagePlaceholder": "https://…/anh-san-pham.jpg",

  "search.start.heading": "Hai cách đưa sản phẩm vào shop",
  "search.start.body":
    "Tìm trong catalog nhà cung cấp ngay tại đây rồi thêm sản phẩm ưng ý vào danh sách nhập, hoặc dùng tiện ích Chrome để thêm bất kỳ sản phẩm AliExpress nào ngay trên trang của nó.",
  "search.start.action": "Cài tiện ích Chrome",

  "search.results.count": "{count} kết quả cho “{query}”",
  "search.results.countUnknown": "Kết quả cho “{query}”",
  "search.results.page": "Trang {page}",
  "search.results.empty.heading": "Không tìm thấy sản phẩm nào cho “{query}”",
  "search.results.empty.body": "Thử từ khóa khác, đổi nhà cung cấp, hoặc dán link sản phẩm ở phía dưới.",
  "search.results.empty.action": "Xóa tìm kiếm",

  "search.card.added": "Đã thêm vào danh sách nhập",
  "search.card.viewSource": "Xem trên trang nhà cung cấp",
  "search.card.orders": "{count} đơn",
  "search.card.noStats": "Chưa có đánh giá",
  "search.card.shipping": "+ {amount} phí ship",
  "search.card.eta": "~{days} ngày",
  "search.card.noImage": "Không có ảnh",

  "search.bulk.placeholder": "https://www.aliexpress.com/item/1005006001.html\n1005006002",
  "search.bulk.summary": "Đã thêm {ok}/{total} vào danh sách nhập",
};
