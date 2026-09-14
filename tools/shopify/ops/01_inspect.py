r"""Doc trang thai product de quyet dinh SKU nao giu, SKU nao xoa.

    cd tools/shopify/ops
    python3 01_inspect.py

Khong ghi gi len store, chi doc. Luu product_snapshot.json lam backup.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # de import duoc gql.py o tools/shopify/

import gql  # noqa: E402

PRODUCT_ID = "gid://shopify/Product/7608740413498"
SNAPSHOT = os.path.join(HERE, "product_snapshot.json")

QUERY = """
query Inspect($id: ID!) {
  product(id: $id) {
    id
    title
    handle
    status
    descriptionHtml
    options { id name optionValues { name } }
    media(first: 100) {
      nodes {
        id
        alt
        mediaContentType
        ... on MediaImage { image { url } }
      }
    }
    variants(first: 100) {
      nodes {
        id
        title
        sku
        price
        inventoryQuantity
        selectedOptions { name value }
      }
    }
  }
}
"""


def main():
    res = gql.call(QUERY, {"id": PRODUCT_ID})

    if "httpError" in res:
        print("HTTP", res["httpError"])
        print(res["body"])
        sys.exit(1)
    if res.get("errors"):
        for e in res["errors"]:
            print(" - GraphQL error:", e.get("message"))
        sys.exit(2)

    p = (res.get("data") or {}).get("product")
    if not p:
        print("Khong tim thay product. Kiem tra PRODUCT_ID va SHOPIFY_DOMAIN trong .env.")
        sys.exit(3)

    print("Title :", p["title"])
    print("Handle:", p["handle"])
    print("Status:", p["status"])
    print("Mo ta :", len(p.get("descriptionHtml") or ""), "ky tu HTML")

    print("\n=== OPTIONS ===")
    for o in p.get("options") or []:
        vals = ", ".join(v["name"] for v in o.get("optionValues") or [])
        print(" - %s: %s" % (o["name"], vals))

    variants = (p.get("variants") or {}).get("nodes") or []
    print("\n=== VARIANTS (%d) ===" % len(variants))
    for v in variants:
        opts = " / ".join("%s=%s" % (s["name"], s["value"]) for s in v.get("selectedOptions") or [])
        print(" - %s" % v["id"])
        print("     title=%r sku=%r gia=%s ton=%s" % (
            v.get("title"), v.get("sku"), v.get("price"), v.get("inventoryQuantity")))
        if opts:
            print("     options: %s" % opts)

    media = (p.get("media") or {}).get("nodes") or []
    print("\n=== MEDIA (%d) ===" % len(media))
    for m in media:
        url = ((m.get("image") or {}).get("url") or "")
        print(" - %s  alt=%r" % (m["id"], m.get("alt")))
        if url:
            print("     %s" % url)

    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        json.dump(p, f, indent=2, ensure_ascii=False)
    print("\nDa luu %s (co descriptionHtml cu de backup)." % os.path.basename(SNAPSHOT))


if __name__ == "__main__":
    main()
