/**
 * How AliExpress ordering is described, everywhere a merchant or a reviewer
 * reads about it.
 *
 * Round one replaced "place hundreds of orders in one click" with "orders are
 * placed with the Chrome extension", which is still untrue: the extension lists
 * the orders waiting and records what the merchant did, and the merchant places
 * and pays for every order on AliExpress. The public pages, the terms and the
 * dashboard must carry the one agreed sentence, and none of them may say the
 * extension places or pays for orders.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { en as dashboardEn, vi as dashboardVi } from "~/lib/i18n-modules/dashboard";

const ORDERING_EN =
  "The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.";
const ORDERING_VI =
  "Tiện ích Chrome liệt kê các đơn đang chờ đặt và mở từng sản phẩm trên AliExpress. Bạn tự đặt và thanh toán đơn ngay trên AliExpress, rồi ghi mã đơn AliExpress vào tiện ích; mã vận đơn bạn thêm ở đó sẽ được gửi sang Shopify.";

/** Page source with JSX line wrapping collapsed, so a sentence split across lines still reads as one. */
function pageText(path: string): string {
  return readFileSync(resolve(__dirname, "../..", path), "utf8").replace(/\s+/g, " ");
}

/** The sentence may open a clause ("For AliExpress, the Chrome extension…"), so only its first letter's case may differ. */
function expectSentence(text: string, sentence: string) {
  expect(text.toLowerCase()).toContain(sentence.toLowerCase());
  expect(text).toContain(sentence.slice(1));
}

const OVERCLAIMS = [
  /orders? (are|is) placed with the (DropshipHub )?(Chrome )?extension/i,
  /place (each|every|your)? ?(AliExpress )?orders? with the (DropshipHub )?(Chrome )?extension/i,
  /extension (places|pays)/i,
  /đơn AliExpress (được|bằng) đặt bằng tiện ích/i,
  /đặt từng đơn AliExpress bằng tiện ích/i,
  /được đặt bằng tiện ích/i,
];

describe("AliExpress ordering copy", () => {
  it.each(["app/routes/_index/route.tsx", "app/routes/support.tsx", "app/routes/terms.tsx"])("%s uses the agreed English sentence", (path) => {
    expectSentence(pageText(path), ORDERING_EN);
  });

  it.each(["app/routes/support.tsx", "app/routes/terms.tsx"])("%s uses the agreed Vietnamese sentence", (path) => {
    expectSentence(pageText(path), ORDERING_VI);
  });

  it("the dashboard welcome banner uses it in both languages", () => {
    expect(dashboardEn["dashboard.welcome.body"]).toContain(ORDERING_EN);
    expect(dashboardVi["dashboard.welcome.body"]).toContain(ORDERING_VI);
  });

  it.each(["app/routes/_index/route.tsx", "app/routes/support.tsx", "app/routes/terms.tsx", "app/lib/i18n-modules/dashboard.ts"])(
    "%s never says the extension places or pays for orders",
    (path) => {
      const text = pageText(path);
      for (const pattern of OVERCLAIMS) expect(text, String(pattern)).not.toMatch(pattern);
    },
  );
});
