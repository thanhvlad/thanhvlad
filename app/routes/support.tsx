import type { MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { LanguageDivider, PublicPage, Section } from "~/components/PublicPage";
import { env } from "~/lib/env.server";

export const meta: MetaFunction = () => [{ title: "Support · DropshipHub" }];

export const loader = async () => ({ supportEmail: env().SUPPORT_EMAIL ?? null });

/**
 * The support page the listing links to.
 *
 * Every answer here has to be something a merchant can do on production today.
 * It used to walk them through "Suppliers → AliExpress → Connect" (a disabled
 * button), a Pay button that opened a sample URL, tracking checked "every 15
 * minutes" with customer emails, and a one-business-day reply promise — each a
 * support ticket, and a listing-accuracy rejection, waiting to happen.
 *
 * Ordering is described in the one sentence the landing page, the terms and the
 * app's own screens share. An earlier version said orders are placed "with the
 * extension", which a merchant reads as the extension placing them; it lists the
 * orders and records what the merchant did on AliExpress, and nothing more.
 */
export default function SupportPage() {
  const { supportEmail } = useLoaderData<typeof loader>();
  const contact = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <span>the support address in the app listing</span>;
  const contactVi = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <span>địa chỉ hỗ trợ trong trang giới thiệu ứng dụng</span>;
  return (
    <PublicPage title="Support" subtitle="Answers to the questions merchants ask most. Tiếng Việt ở phía dưới.">
      <Section heading="Contact">
        <p>
          Email {contact} with your store domain and, for an order problem, the order number. From inside the app, Settings → Support has the same links
          plus the details we need to find your store.
        </p>
      </Section>
      <Section heading="Adding AliExpress products">
        <p>
          Products are added with the DropshipHub Chrome extension. In the app, Settings → Advanced shows the app URL and a token; paste both into the
          extension's options. Then open a product on AliExpress and press Add to import list. The title, images, variants, prices and description are
          read from that page, and the product waits on the import list for you to edit it and push it to your store.
        </p>
        <p>
          AliExpress pages do not state a package weight. Set a default weight under Settings → General → Products so weight-based shipping rates are
          not calculated on zero, or enter the real weight before you push.
        </p>
      </Section>
      <Section heading="Placing AliExpress orders">
        <p>
          Paid Shopify orders wait on the Orders page. The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress.
          You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.
        </p>
        <p>AliExpress does not let apps charge your account, so DropshipHub never pays for an order and never holds your money.</p>
      </Section>
      <Section heading="The Request fulfillment button">
        <p>
          Settings → Fulfilment service registers the app as a fulfilment service in Shopify. Products stocked at the app's location then show Request
          fulfillment on the Shopify order page; clicking it sends the order to the app, where it waits to be placed on AliExpress as described
          above. Unmapped lines are rejected back with the reason.
        </p>
      </Section>
      <Section heading="Tracking numbers">
        <p>
          When a tracking number is recorded for an AliExpress order, in the extension or on the order in the app, the app adds it to the Shopify fulfilment, and Shopify emails your customer if "Email the
          customer their tracking number" is on under Settings → General. A supplier order that ships as several parcels puts every number on the one
          fulfilment.
        </p>
      </Section>
      <Section heading="Plan limits">
        <p>
          Products, stores and staff add up across every store on your account. When a limit is reached the app tells you which plan fixes it; existing
          data is never removed by a downgrade. Settings → Plan shows usage and lets you change plans through Shopify billing.
        </p>
      </Section>
      <Section heading="Deleting your data">
        <p>Uninstall the app from Shopify. Shopify asks us to erase the store 48 hours later and we do; see the privacy policy.</p>
      </Section>

      <LanguageDivider label="Tiếng Việt" />

      <Section heading="Liên hệ">
        <p>
          Gửi email tới {contactVi} kèm tên miền cửa hàng và, nếu là vấn đề đơn hàng, số đơn. Trong ứng dụng, Cài đặt → Hỗ trợ có các liên kết tương tự
          cùng thông tin chúng tôi cần để tìm cửa hàng của bạn.
        </p>
      </Section>
      <Section heading="Thêm sản phẩm AliExpress">
        <p>
          Sản phẩm được thêm bằng tiện ích DropshipHub cho Chrome. Trong ứng dụng, Cài đặt → Nâng cao hiển thị địa chỉ ứng dụng và token; dán cả hai vào
          phần tuỳ chọn của tiện ích. Sau đó mở một sản phẩm trên AliExpress và bấm Add to import list. Tiêu đề, ảnh, biến thể, giá và mô tả được đọc từ
          chính trang đó, và sản phẩm nằm chờ trong danh sách nhập để bạn chỉnh sửa rồi đẩy lên cửa hàng.
        </p>
        <p>
          Trang AliExpress không ghi cân nặng gói hàng. Hãy đặt cân nặng mặc định trong Cài đặt → Chung → Sản phẩm để phí vận chuyển theo cân nặng không bị
          tính bằng 0, hoặc nhập cân nặng thật trước khi đẩy.
        </p>
      </Section>
      <Section heading="Đặt đơn AliExpress">
        <p>
          Đơn Shopify đã thanh toán nằm chờ ở trang Đơn hàng. Tiện ích Chrome liệt kê các đơn đang chờ đặt và mở từng sản phẩm trên AliExpress. Bạn tự
          đặt và thanh toán đơn ngay trên AliExpress, rồi ghi mã đơn AliExpress vào tiện ích; mã vận đơn bạn thêm ở đó sẽ được gửi sang Shopify.
        </p>
        <p>AliExpress không cho phép ứng dụng trừ tiền tài khoản của bạn, nên DropshipHub không bao giờ thanh toán đơn thay bạn và không giữ tiền của bạn.</p>
      </Section>
      <Section heading="Nút Request fulfillment">
        <p>
          Cài đặt → Dịch vụ giao hàng đăng ký ứng dụng làm fulfillment service trong Shopify. Sản phẩm để tồn kho ở địa điểm của ứng dụng sẽ có nút Request
          fulfillment trên trang đơn hàng Shopify; bấm nút là đơn được gửi sang ứng dụng và chờ được đặt trên AliExpress như mô tả ở trên. Dòng chưa ghép
          sẽ bị trả lại kèm lý do.
        </p>
      </Section>
      <Section heading="Mã vận đơn">
        <p>
          Khi mã vận đơn của một đơn AliExpress được ghi lại, trong tiện ích hoặc trên đơn trong ứng dụng, ứng dụng thêm mã đó vào fulfillment trên Shopify, và Shopify gửi email cho khách nếu mục "Gửi email mã vận
          đơn cho khách" đang bật trong Cài đặt → Chung. Đơn nhà cung cấp gửi thành nhiều kiện sẽ có đủ mã trên cùng một fulfillment.
        </p>
      </Section>
      <Section heading="Giới hạn gói">
        <p>
          Sản phẩm, cửa hàng và nhân viên được cộng dồn trên mọi cửa hàng cùng tài khoản. Khi chạm giới hạn, ứng dụng cho biết gói nào giải quyết được; hạ
          gói không bao giờ xoá dữ liệu hiện có. Cài đặt → Gói dịch vụ hiển thị mức dùng và cho đổi gói qua thanh toán Shopify.
        </p>
      </Section>
      <Section heading="Xoá dữ liệu">
        <p>Gỡ ứng dụng khỏi Shopify. 48 giờ sau Shopify yêu cầu chúng tôi xoá cửa hàng và chúng tôi thực hiện; xem chính sách quyền riêng tư.</p>
      </Section>
    </PublicPage>
  );
}
