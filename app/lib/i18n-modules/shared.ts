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
};
