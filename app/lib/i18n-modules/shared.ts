/**
 * Strings used by the shared components in `app/components`, which belong to no
 * single screen. English is the source of truth; a key missing from `vi` falls
 * back to English.
 */
export const en = {
  "paginator.summary": "Page {page} of {pages} · {total} total",

  // ---- Error screen -----------------------------------------------------------
  "errorScreen.status": "Error {status}",
  "errorScreen.retry": "Try again",
  "errorScreen.home": "Back to home",
  "errorScreen.notFound.title": "This page does not exist",
  "errorScreen.notFound.body": "It may have been removed, or the link you followed is out of date. Go back and open it from the list again.",
  "errorScreen.forbidden.title": "You do not have access to this",
  "errorScreen.forbidden.body": "Your role on this store does not allow it. Ask the store owner or an admin to change your role under Settings → Staff.",
  "errorScreen.unexpected.title": "Something went wrong",
  "errorScreen.unexpected.body": "This page could not be loaded. Try again in a moment; if it keeps happening, contact support and mention the time it happened.",

  // ---- Settings > Support: environment ------------------------------------
  // Kept here rather than in the settings module, which another change owns
  // this round; the keys are namespaced so they can move without a rename.
  "support.environment.aiEndpoint": "AI rewrite endpoint",
  "support.environment.aiDirect": "Anthropic",
  "support.environment.aiGateway": "Third-party gateway",
  "support.environment.aiNotConfigured": "Not configured",

  // ---- Reports: recalculation ---------------------------------------------
  // Same reason: the reports module is not part of this change.
  "reports.recalculate.queued": "Recalculating the last {n} day(s) in the background. Reload this page in a moment to see the new figures.",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "paginator.summary": "Trang {page}/{pages} · {total} mục",

  "errorScreen.status": "Lỗi {status}",
  "errorScreen.retry": "Thử lại",
  "errorScreen.home": "Về trang chủ",
  "errorScreen.notFound.title": "Trang này không tồn tại",
  "errorScreen.notFound.body": "Có thể nó đã bị xoá, hoặc đường dẫn bạn bấm đã cũ. Hãy quay lại và mở lại từ danh sách.",
  "errorScreen.forbidden.title": "Bạn không có quyền làm việc này",
  "errorScreen.forbidden.body": "Vai trò của bạn trên cửa hàng này không cho phép. Nhờ chủ cửa hàng hoặc admin đổi vai trò trong Cài đặt → Nhân viên.",
  "errorScreen.unexpected.title": "Đã có lỗi xảy ra",
  "errorScreen.unexpected.body": "Không tải được trang này. Hãy thử lại sau giây lát; nếu vẫn lỗi, liên hệ hỗ trợ và cho biết thời điểm xảy ra.",

  "support.environment.aiEndpoint": "Máy chủ viết lại bằng AI",
  "support.environment.aiDirect": "Anthropic",
  "support.environment.aiGateway": "Cổng trung gian bên thứ ba",
  "support.environment.aiNotConfigured": "Chưa cấu hình",

  "reports.recalculate.queued": "Đang tính lại {n} ngày gần nhất ở chế độ nền. Tải lại trang sau giây lát để xem số liệu mới.",
};
