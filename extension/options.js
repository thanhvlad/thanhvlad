/* global chrome */
const appUrl = document.getElementById("appUrl");
const token = document.getElementById("token");
const saved = document.getElementById("saved");

chrome.storage.sync.get(["appUrl", "token"]).then((v) => {
  appUrl.value = v.appUrl ?? "";
  token.value = v.token ?? "";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({ appUrl: appUrl.value.trim(), token: token.value.trim() });
  saved.textContent = "Saved";
  setTimeout(() => (saved.textContent = ""), 2000);
});
