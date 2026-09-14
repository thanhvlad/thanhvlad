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

## ops/ - cac script viec cu the

| File | Tac dung |
|------|----------|
| `shop-info.graphql` | Query mau, kiem tra ket noi |
| `01_inspect.py` | Doc product Aurora: options, variants, media. Luu `product_snapshot.json` lam backup |
| `02_apply.py` | Don SKU lech mau + ghi de mo ta tu `product-description.html` |
| `product-description.html` | Noi dung landing page moi cho product Aurora |

```bash
cd tools/shopify/ops
python3 01_inspect.py        # chi doc
python3 02_apply.py          # DRY RUN, in ke hoach, khong ghi
python3 02_apply.py --apply  # thuc su ghi len store
```

`02_apply.py` loc variant lech mau theo `DROP_KEYWORDS` (bat ca tieng Viet lan
tieng Anh). Muon tu quyet dinh thi dien ID vao `FORCE_DELETE_VARIANT_IDS`,
khi do phan doan theo tu khoa bi bo qua. Script chan cung khong cho xoa het
variant vi Shopify bat buoc product con toi thieu 1.

Xoa variant khong lam mat line item tren don da phat sinh. Cai can archive
thay vi delete la PRODUCT, khong phai variant.

## Vi sao phai chay o may that, khong chay duoc trong phien cloud

Phien Claude Code loai `anthropic_cloud` (mo tu claude.ai web, iOS, desktop app)
chay trong container sandbox, ra ngoai qua egress proxy co allowlist dong.
`<shop>.myshopify.com` khong nam trong allowlist nen CONNECT bi tra 403, ngay
ca `example.com` cung bi chan. Token dung hay sai khong lien quan.

Phien loai `bridge` (Remote Control, mo tu `claude` CLI hoac VS Code tren may
ban) chay trang tren may ban va dung mang cua ban, nen goi thang Shopify binh
thuong. Do la ly do truoc day van chay duoc.

Kiem tra nhanh moi truong hien tai:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://example.com/
# 200 -> mang mo, chay duoc
# 000 kem "CONNECT tunnel failed, response 403" -> sandbox, phai chay o may that
```
