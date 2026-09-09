/* global chrome */
const status = document.getElementById("status");
const button = document.getElementById("add");
const urlBox = document.getElementById("url");

document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function appOrigin(raw) {
  // The App URL field takes an ORIGIN. A value carrying the endpoint path makes
  // the request url double up (".../api/extension/capture/api/extension/capture")
  // and the browser reports only "Failed to fetch". Keep the origin, drop the rest.
  const value = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function currentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? "";
}

function looksLikeProduct(url) {
  return /aliexpress\.[a-z.]+\/(item|i)\/\d+/i.test(url) || /cjdropshipping\.com\/product\//i.test(url);
}

(async () => {
  const url = await currentTabUrl();
  urlBox.innerHTML = `<small>${url ? url.slice(0, 80) : "No tab"}</small>`;
  if (!looksLikeProduct(url)) {
    status.innerHTML = '<span class="err">Open an AliExpress or CJ product page first.</span>';
    return;
  }
  const { appUrl, token } = await chrome.storage.sync.get(["appUrl", "token"]);
  if (!appUrl || !token) {
    status.innerHTML = '<span class="err">Set the app URL and token in options.</span>';
    return;
  }
  const base = appOrigin(appUrl);
  if (!base) {
    status.innerHTML = `<span class="err">"${appUrl}" is not a valid app URL.</span>`;
    return;
  }
  const endpoint = `${base}/api/extension/capture`;
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Sending…";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      });
      const body = await response.json();
      if (body.ok) {
        status.innerHTML = `<span class="ok">Added: ${body.title ?? "product"}.</span> <a href="${body.importListUrl}" target="_blank">Open import list</a>`;
      } else {
        status.innerHTML = `<span class="err">${body.error ?? "Failed"}</span>`;
        button.disabled = false;
      }
    } catch (error) {
      // "Failed to fetch" alone hides which url was actually called; show it.
      status.innerHTML = `<span class="err">${error.message}<br>Called: ${endpoint}<br>Check the app URL in options - it needs the https:// prefix.</span>`;
      button.disabled = false;
    }
  });
})();
