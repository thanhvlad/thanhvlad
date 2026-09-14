r"""Don SKU lech mau + cap nhat mo ta cho product den Aurora.

    cd tools/shopify/ops
    python3 02_apply.py            # DRY RUN, chi in ke hoach, khong ghi gi
    python3 02_apply.py --apply    # thuc su ghi len store

Chay 01_inspect.py truoc de biet dang co variant nao.

Lich su don hang: xoa variant KHONG lam mat line item tren cac don da phat
sinh, Shopify giu snapshot tren don. Cai can archive thay vi delete la
PRODUCT, khong phai variant.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # de import duoc gql.py o tools/shopify/

import gql  # noqa: E402

PRODUCT_ID = "gid://shopify/Product/7608740413498"
DESCRIPTION_FILE = os.path.join(HERE, "product-description.html")

# Mau dung theo anh mau: trang + num crom. Variant nao co option value chua
# mot trong cac tu duoi day se bi coi la LECH MAU va de xuat xoa.
DROP_KEYWORDS = [
    "black", "den", "đen",
    "green", "xanh",
    "pink", "hong", "hồng",
    "blue",
    "grey", "gray", "xam", "xám",
    "beige", "kem",
    "yellow", "vang", "vàng",
    "red", "do", "đỏ",
    "orange", "cam",
    "purple", "tim", "tím",
    "brown", "nau", "nâu",
]

# Muon tu quyet dinh thay vi de script doan theo tu khoa thi dien thang ID
# variant vao day. Co gia tri thi DROP_KEYWORDS bi bo qua.
FORCE_DELETE_VARIANT_IDS = []

# ID media muon go (lay tu 01_inspect.py). De trong thi khong go anh nao.
DELETE_MEDIA_IDS = []

Q_READ = """
query Read($id: ID!) {
  product(id: $id) {
    id
    title
    variants(first: 100) {
      nodes { id title sku selectedOptions { name value } }
    }
  }
}
"""

M_UPDATE_NEW = """
mutation U($id: ID!, $html: String!) {
  productUpdate(product: {id: $id, descriptionHtml: $html}) {
    product { id }
    userErrors { field message }
  }
}
"""

M_UPDATE_OLD = """
mutation U($id: ID!, $html: String!) {
  productUpdate(input: {id: $id, descriptionHtml: $html}) {
    product { id }
    userErrors { field message }
  }
}
"""

M_DELETE_VARIANTS = """
mutation D($productId: ID!, $ids: [ID!]!) {
  productVariantsBulkDelete(productId: $productId, variantsIds: $ids) {
    product { id }
    userErrors { field message }
  }
}
"""

M_DELETE_MEDIA = """
mutation M($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message }
  }
}
"""


def die(res, what):
    if "httpError" in res:
        print("  HTTP %s khi %s" % (res["httpError"], what))
        print("  " + res["body"][:500])
        sys.exit(1)
    if res.get("errors"):
        print("  GraphQL error khi %s:" % what)
        for e in res["errors"]:
            print("   -", e.get("message"))
        sys.exit(2)
    errs = gql.collect_user_errors(res.get("data"))
    if errs:
        for path, items in errs:
            for it in items:
                print("   - userError %s: %s %s" % (path, it.get("field"), it.get("message")))
        sys.exit(3)


def looks_wrong_color(variant):
    haystack = " ".join(
        [variant.get("title") or ""]
        + [s.get("value") or "" for s in variant.get("selectedOptions") or []]
    ).lower()
    return [k for k in DROP_KEYWORDS if k in haystack]


def main():
    apply_mode = "--apply" in sys.argv

    res = gql.call(Q_READ, {"id": PRODUCT_ID})
    die(res, "doc product")
    product = (res.get("data") or {}).get("product")
    if not product:
        print("Khong tim thay product.")
        sys.exit(3)

    variants = (product.get("variants") or {}).get("nodes") or []
    print("Product:", product["title"])
    print("Dang co %d variant.\n" % len(variants))

    if FORCE_DELETE_VARIANT_IDS:
        to_delete = [v for v in variants if v["id"] in FORCE_DELETE_VARIANT_IDS]
        print("Dung danh sach FORCE_DELETE_VARIANT_IDS.")
    else:
        to_delete = [v for v in variants if looks_wrong_color(v)]
        print("Doan theo tu khoa mau trong DROP_KEYWORDS.")

    delete_ids = {v["id"] for v in to_delete}
    keep = [v for v in variants if v["id"] not in delete_ids]

    print("\n=== GIU (%d) ===" % len(keep))
    for v in keep:
        print(" + %s  sku=%r" % (v.get("title"), v.get("sku")))

    print("\n=== XOA (%d) ===" % len(to_delete))
    for v in to_delete:
        why = looks_wrong_color(v)
        print(" - %s  sku=%r  khop=%s" % (v.get("title"), v.get("sku"), ",".join(why) or "thu cong"))

    if not keep:
        print("\nDUNG LAI: Shopify bat buoc product phai con it nhat 1 variant.")
        print("Sua DROP_KEYWORDS hoac dung FORCE_DELETE_VARIANT_IDS.")
        sys.exit(4)

    html = None
    print("\n=== MO TA ===")
    if os.path.exists(DESCRIPTION_FILE):
        with open(DESCRIPTION_FILE, encoding="utf-8") as f:
            html = f.read()
        print(" Se ghi de bang %s (%d ky tu)." % (os.path.basename(DESCRIPTION_FILE), len(html)))
        if "[ĐIỀN" in html:
            print(" CANH BAO: file van con cho [DIEN...] chua dien so lieu that.")
    else:
        print(" Khong thay %s, bo qua buoc cap nhat mo ta." % os.path.basename(DESCRIPTION_FILE))

    if DELETE_MEDIA_IDS:
        print("\n=== MEDIA ===")
        print(" Se go %d anh." % len(DELETE_MEDIA_IDS))

    if not apply_mode:
        print("\n[DRY RUN] Chua ghi gi len store. Chay lai voi --apply de thuc hien.")
        return

    print("\n--- Bat dau ghi ---")

    if html is not None:
        res = gql.call(M_UPDATE_NEW, {"id": PRODUCT_ID, "html": html})
        if res.get("errors"):
            joined = " ".join((e.get("message") or "").lower() for e in res["errors"])
            if "product" in joined and ("argument" in joined or "field" in joined):
                print("  productUpdate(product:) bi tu choi, thu lai dang input:")
                res = gql.call(M_UPDATE_OLD, {"id": PRODUCT_ID, "html": html})
        die(res, "cap nhat mo ta")
        print("  Da cap nhat mo ta.")

    if to_delete:
        ids = [v["id"] for v in to_delete]
        res = gql.call(M_DELETE_VARIANTS, {"productId": PRODUCT_ID, "ids": ids})
        die(res, "xoa variant")
        print("  Da xoa %d variant." % len(ids))

    if DELETE_MEDIA_IDS:
        res = gql.call(M_DELETE_MEDIA, {"productId": PRODUCT_ID, "mediaIds": DELETE_MEDIA_IDS})
        die(res, "xoa media")
        print("  Da go %d anh." % len(DELETE_MEDIA_IDS))

    print("\nXong. Chay lai 01_inspect.py de kiem tra ket qua.")


if __name__ == "__main__":
    main()
