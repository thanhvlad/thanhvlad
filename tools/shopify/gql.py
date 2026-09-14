r"""
Goi Shopify Admin GraphQL cho store trong .env.

Dung:
  python gql.py ops/abc.graphql                 # chi query
  python gql.py ops/abc.graphql ops/abc.vars.json
  python gql.py -q "{ shop { name } }"

Token doc tu .env, KHONG BAO GIO in ra.
"""
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

# Console Windows mac dinh la cp1252, in tieng Viet se nem UnicodeEncodeError
# va lam chet script giua chung. Moi script trong ops/ deu import gql nen
# chuyen stdout/stderr sang utf-8 o day la du cho ca bo.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, ".env")
API_VERSION = "2026-07"


def load_env(path=ENV_PATH):
    values = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                values[k.strip()] = v.strip()
    except FileNotFoundError:
        print("Khong thay .env tai", path)
        sys.exit(1)
    return values


def ssl_ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _is_throttled(res):
    for e in (res.get("errors") or []):
        code = ((e.get("extensions") or {}).get("code") or "").upper()
        if "THROTTLE" in code or "throttle" in (e.get("message") or "").lower():
            return True
    return False


def call(query, variables=None, retries=5):
    """Tu thu lai khi Shopify bop toc do hoac loi may chu tam thoi.

    Khong co buoc nay thi mutation chay lien tuc se im lang that bai
    (data = null, userErrors rong) va script de bao nham la thanh cong.
    """
    for attempt in range(retries):
        res = _call_once(query, variables)
        http = res.get("httpError")
        transient = _is_throttled(res) or (http and (http >= 500 or http == 429))
        if not transient:
            return res
        time.sleep(2.0 * (attempt + 1))
    return res


def _call_once(query, variables=None):
    env = load_env()
    shop = env.get("SHOPIFY_DOMAIN")
    token = env.get("SHOPIFY_ACCESS_TOKEN")
    if not shop or not token:
        print("Thieu SHOPIFY_DOMAIN hoac SHOPIFY_ACCESS_TOKEN trong .env")
        sys.exit(1)

    url = "https://%s/admin/api/%s/graphql.json" % (shop, API_VERSION)
    payload = {"query": query}
    if variables:
        payload["variables"] = variables

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60, context=ssl_ctx()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return {"httpError": e.code, "body": body[:2000]}
    except urllib.error.URLError as e:
        # Khong mo duoc ket noi (DNS hong, proxy chan, mat mang). Bat o day de
        # script bao loi doc duoc thay vi nem traceback giua chung.
        return {"netError": str(e.reason), "url": url}


def collect_user_errors(node, path="", out=None):
    """Tim moi userErrors long trong ket qua, ke ca lop sau."""
    if out is None:
        out = []
    if isinstance(node, dict):
        for k, v in node.items():
            p = path + "." + k if path else k
            if k in ("userErrors", "mediaUserErrors") and isinstance(v, list) and v:
                out.append((p, v))
            else:
                collect_user_errors(v, p, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            collect_user_errors(v, "%s[%d]" % (path, i), out)
    return out


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    if args[0] == "-q":
        query = args[1]
        variables = json.loads(args[2]) if len(args) > 2 else None
    else:
        with open(args[0], encoding="utf-8") as f:
            query = f.read()
        variables = None
        if len(args) > 1:
            with open(args[1], encoding="utf-8") as f:
                variables = json.load(f)

    res = call(query, variables)

    if "netError" in res:
        print("Khong ket noi duoc toi", res["url"])
        print("Ly do:", res["netError"])
        sys.exit(1)

    if "httpError" in res:
        print("HTTP", res["httpError"])
        print(res["body"])
        sys.exit(1)

    if "errors" in res:
        print("=== GraphQL errors ===")
        for e in res["errors"]:
            print(" -", e.get("message"))
        print()

    errs = collect_user_errors(res.get("data"))
    if errs:
        print("=== userErrors ===")
        for path, items in errs:
            for it in items:
                print(" - %s: %s %s" % (path, it.get("field"), it.get("message")))
        print()

    print(json.dumps(res.get("data"), indent=2, ensure_ascii=False))

    if "errors" in res or errs:
        sys.exit(2)


if __name__ == "__main__":
    main()
