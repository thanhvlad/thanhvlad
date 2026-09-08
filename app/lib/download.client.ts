/**
 * Download a route response from inside the embedded admin.
 *
 * A plain link or `target="_blank"` opens a top-level tab that carries no
 * session token, so `authenticate.admin()` bounces it to the login form instead
 * of returning the file — the merchant sees a shop-domain prompt in a new tab
 * and no download. App Bridge attaches the token to same-origin fetches, so
 * fetch the file here and hand the blob to the browser instead.
 */
export async function downloadAuthed(url: string, filename: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
