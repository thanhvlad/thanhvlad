# Extension / capture API

`POST /api/extension/capture`

Adds one or more supplier products to the shop's import list. Used by the bundled
Chrome extension (`extension/`) and usable from any script.

## Auth

`Authorization: Bearer <token>` — generate the token in the app under
**Settings → Advanced → Browser extension / API**. Rotating the token invalidates the
previous one; revoking disables the endpoint for that shop.

## Request

```json
{ "url": "https://www.aliexpress.com/item/1005006001.html" }
```

or

```json
{ "urls": ["https://www.aliexpress.com/item/1005006001.html", "1005006002"], "pricingRuleId": "optional" }
```

Up to 25 references per call. AliExpress URLs/IDs and CJ product URLs are recognised.

## Response

```json
{
  "ok": true,
  "url": "https://www.aliexpress.com/item/1005006001.html",
  "importedProductId": "cm…",
  "title": "Wireless Bluetooth Earbuds Pro…",
  "platform": "ALIEXPRESS",
  "results": [ { "url": "…", "ok": true, "importedProductId": "…", "title": "…" } ],
  "importListUrl": "https://<shop>.myshopify.com/admin/apps/<api-key>/app/import"
}
```

Errors: `401` missing/invalid token, `400` bad body, per-item `ok:false` with `error`.

CORS is open (`*`) so the extension can call from supplier origins; the bearer token is
the only credential and should be treated like a password.

## Installing the extension

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select `extension/`.
2. Open the extension options, paste the app URL (e.g. `https://your-app.example.com`)
   and the token.
3. On any AliExpress / CJ product page click the extension icon → **Add to import list**.
