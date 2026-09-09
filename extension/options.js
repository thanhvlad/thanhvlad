/* global chrome */
const appUrl = document.getElementById("appUrl");
const token = document.getElementById("token");
const saved = document.getElementById("saved");

chrome.storage.sync.get(["appUrl", "token"]).then((v) => {
  appUrl.value = v.appUrl ?? "";
  token.value = v.token ?? "";
});

/**
 * Normalise what the merchant typed. Without a scheme the value becomes a
 * RELATIVE url at fetch time, so the browser looks for it inside the extension
 * and the only symptom is "Failed to fetch" - which says nothing useful.
 */
function normaliseAppUrl(raw) {
  let value = raw.trim().replace(/\/+$/, "");
  if (!value) return { error: "Enter the app URL, e.g. https://dropship.windspace.agency" };
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: `"${raw.trim()}" is not a valid URL.` };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { error: `Enter only the origin, without a path. Did you mean ${parsed.origin} ?` };
  }
  return { value: parsed.origin };
}

document.getElementById("save").addEventListener("click", async () => {
  const result = normaliseAppUrl(appUrl.value);
  if (result.error) {
    saved.textContent = result.error;
    saved.style.color = "#b3261e";
    return;
  }
  appUrl.value = result.value;
  saved.style.color = "";
  await chrome.storage.sync.set({ appUrl: result.value, token: token.value.trim() });
  saved.textContent = "Saved";
  setTimeout(() => (saved.textContent = ""), 2000);
});
