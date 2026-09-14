# tools/shopify - goi Admin API bang token

Chay GraphQL truc tiep len Admin API cua mot store, dung Admin API access token
thay vi luong OAuth cua app. Dung de kiem tra nhanh du lieu that ma khong phai
dung ca app len.

API version pin `2026-07`, khop voi `shopify.app.toml` va `app/shopify.server.ts`.
Khi nang version cua app thi sua luon `API_VERSION` trong `gql.py`.

## Cai dat

```bash
cp .env.example .env      # roi dien SHOPIFY_DOMAIN va SHOPIFY_ACCESS_TOKEN
chmod 600 .env
```

`.env` da nam trong `.gitignore` - dung bao gio commit no.

## Dung

```bash
python3 gql.py -q "{ shop { name } }"          # query thang tren dong lenh
python3 gql.py ops/shop-info.graphql           # query tu file
python3 gql.py ops/abc.graphql ops/abc.vars.json   # kem variables
```

Script tu thu lai khi bi Shopify bop toc do (throttle) hoac gap loi 5xx/429,
in ra `userErrors` long o moi tang, va thoat khac 0 khi co loi - hop de noi vao
CI hoac script khac.

Token chi doc tu `.env` va khong bao gio duoc in ra.

## Ma thoat

| Ma | Nghia |
|----|-------|
| 0  | Thanh cong |
| 1  | Thieu bien moi truong, loi HTTP, hoac khong ket noi duoc |
| 2  | Goi duoc nhung co `errors` hoac `userErrors` |

## Luu y ve moi truong mang

Script can mo duoc ket noi ra `<shop>.myshopify.com`. Trong sandbox/CI co chinh
sach chan egress, CONNECT se bi tra 403 va script bao
`Khong ket noi duoc toi ... Ly do: Tunnel connection failed: 403 Forbidden`.
Do la chan o tang mang, khong phai token sai.
