import type { MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { LanguageDivider, PublicPage, Section } from "~/components/PublicPage";
import { env } from "~/lib/env.server";

export const meta: MetaFunction = () => [{ title: "Privacy policy · DropshipHub" }];

export const loader = async () => ({ supportEmail: env().SUPPORT_EMAIL ?? null, updated: "2026-09-08" });

/**
 * The privacy policy the App Store listing links to. It describes what the
 * app actually does with data, so it must change when the code does — the
 * list of third parties below is the complete set of places data goes.
 */
export default function PrivacyPage() {
  const { supportEmail, updated } = useLoaderData<typeof loader>();
  const contact = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <span>the support address in the app listing</span>;
  return (
    <PublicPage title="Privacy policy" subtitle={`Last updated ${updated}. Tiếng Việt ở phía dưới.`}>
      <Section heading="Who we are">
        <p>
          DropshipHub is a Shopify app that helps merchants source products from suppliers such as AliExpress and CJ Dropshipping, place supplier orders for
          their Shopify orders and sync tracking back to Shopify. This policy explains what data the app processes on behalf of the merchant who installs it,
          why, and for how long.
        </p>
      </Section>
      <Section heading="What we collect">
        <ul>
          <li>
            <strong>Store information</strong>: store name, domain, email, currency, timezone, primary location, and the access token Shopify issues to the
            app.
          </li>
          <li>
            <strong>Orders</strong>: order number, line items, totals, payment and fulfilment status, and the shipping details needed to deliver the order —
            recipient name, address, phone, email and, for some destinations, a customs identifier (for example CPF in Brazil or RUT in Chile).
          </li>
          <li>
            <strong>Products</strong>: the products the merchant imports or links, their variants, prices, inventory and images.
          </li>
          <li>
            <strong>Supplier accounts</strong>: the OAuth token or API key for the supplier account the merchant connects, encrypted at rest.
          </li>
          <li>
            <strong>Usage</strong>: an activity log of actions taken in the app, background job results and in-app notifications.
          </li>
        </ul>
      </Section>
      <Section heading="Why">
        <p>
          To do what the merchant installed the app for: import products, place supplier orders for Shopify orders (which requires sending the recipient's
          shipping details to the supplier the merchant chose), sync tracking numbers and order status back to Shopify, keep prices and stock in step with the
          supplier, and report revenue, cost and profit.
        </p>
      </Section>
      <Section heading="Who we share it with">
        <ul>
          <li>
            <strong>The supplier the merchant chose</strong> (AliExpress or CJ Dropshipping) receives the recipient's name, address, phone and customs
            identifier for each order the merchant places, because the supplier ships the parcel. Their own privacy policies apply to that data.
          </li>
          <li>
            <strong>Shopify</strong> receives fulfilments, tracking numbers, product and inventory updates through the Admin API.
          </li>
          <li>
            <strong>An email provider</strong>, only when the merchant enables notification emails, receives the merchant's chosen address and the
            notification text. Customer data is never emailed.
          </li>
          <li>
            <strong>Anthropic</strong>, only when the merchant uses AI-assisted variant mapping, receives product option names such as "Red / XL" to match
            variants. No order or customer data is sent.
          </li>
        </ul>
        <p>We do not sell data, and we do not use it for advertising.</p>
      </Section>
      <Section heading="Retention">
        <p>
          Data is kept while the app is installed. When a merchant uninstalls, Shopify asks the app to erase the store 48 hours later and the app does so,
          including the store's access token and supplier tokens. Regardless of that request, any store still uninstalled after 30 days is erased
          automatically.
        </p>
        <p>
          When a customer asks their merchant for their data or its deletion, Shopify relays the request to the app: the app hands the merchant an export of
          the customer's orders, or erases the personal fields on those orders while keeping the anonymised totals the merchant's accounts depend on.
        </p>
      </Section>
      <Section heading="Security">
        <p>
          Traffic is encrypted in transit. Supplier tokens are encrypted at rest with AES-256-GCM. Access to the app runs through Shopify's own login and
          session tokens; there is no separate password.
        </p>
      </Section>
      <Section heading="Contact">
        <p>Questions about this policy: {contact}.</p>
      </Section>

      <LanguageDivider label="Tiếng Việt" />

      <Section heading="Chính sách quyền riêng tư">
        <p>
          DropshipHub là ứng dụng Shopify giúp người bán tìm nguồn hàng từ các nhà cung cấp như AliExpress và CJ Dropshipping, đặt đơn nhà cung cấp cho đơn
          hàng Shopify và đồng bộ mã vận đơn về Shopify. Chính sách này nêu rõ ứng dụng xử lý dữ liệu gì thay mặt người bán, vì sao và trong bao lâu.
        </p>
      </Section>
      <Section heading="Dữ liệu thu thập">
        <ul>
          <li>
            <strong>Thông tin cửa hàng</strong>: tên, tên miền, email, tiền tệ, múi giờ, địa điểm chính và access token Shopify cấp cho ứng dụng.
          </li>
          <li>
            <strong>Đơn hàng</strong>: số đơn, dòng sản phẩm, tổng tiền, trạng thái thanh toán/giao hàng và thông tin giao hàng cần để giao đơn — tên,
            địa chỉ, điện thoại, email người nhận và, với một số nước, mã số hải quan (ví dụ CPF ở Brazil, RUT ở Chile).
          </li>
          <li>
            <strong>Sản phẩm</strong>: sản phẩm người bán nhập hoặc liên kết, biến thể, giá, tồn kho và hình ảnh.
          </li>
          <li>
            <strong>Tài khoản nhà cung cấp</strong>: token OAuth hoặc API key của tài khoản nhà cung cấp mà người bán kết nối, được mã hoá khi lưu.
          </li>
          <li>
            <strong>Sử dụng</strong>: nhật ký hoạt động trong ứng dụng, kết quả tác vụ nền và thông báo trong app.
          </li>
        </ul>
      </Section>
      <Section heading="Mục đích">
        <p>
          Để làm đúng việc người bán cài ứng dụng: nhập sản phẩm, đặt đơn nhà cung cấp cho đơn Shopify (cần gửi thông tin giao hàng của người nhận cho nhà
          cung cấp người bán đã chọn), đồng bộ mã vận đơn và trạng thái về Shopify, cập nhật giá/tồn kho theo nhà cung cấp và báo cáo doanh thu, chi phí,
          lợi nhuận.
        </p>
      </Section>
      <Section heading="Chia sẻ với ai">
        <ul>
          <li>
            <strong>Nhà cung cấp người bán chọn</strong> (AliExpress hoặc CJ Dropshipping) nhận tên, địa chỉ, điện thoại và mã hải quan của người nhận cho
            mỗi đơn người bán đặt, vì nhà cung cấp là bên gửi hàng. Chính sách riêng tư của họ áp dụng cho dữ liệu đó.
          </li>
          <li>
            <strong>Shopify</strong> nhận fulfillment, mã vận đơn, cập nhật sản phẩm và tồn kho qua Admin API.
          </li>
          <li>
            <strong>Dịch vụ gửi email</strong>, chỉ khi người bán bật email thông báo, nhận địa chỉ người bán chọn và nội dung thông báo. Dữ liệu khách
            hàng không bao giờ được gửi qua email.
          </li>
          <li>
            <strong>Anthropic</strong>, chỉ khi người bán dùng ghép biến thể bằng AI, nhận tên tuỳ chọn sản phẩm như "Đỏ / XL" để ghép biến thể. Không gửi
            dữ liệu đơn hàng hay khách hàng.
          </li>
        </ul>
        <p>Chúng tôi không bán dữ liệu và không dùng dữ liệu cho quảng cáo.</p>
      </Section>
      <Section heading="Thời gian lưu">
        <p>
          Dữ liệu được giữ khi ứng dụng còn được cài. Khi người bán gỡ ứng dụng, 48 giờ sau Shopify yêu cầu ứng dụng xoá cửa hàng và ứng dụng thực hiện,
          gồm cả access token và token nhà cung cấp. Bất kể yêu cầu đó, cửa hàng nào vẫn ở trạng thái đã gỡ sau 30 ngày sẽ tự động bị xoá.
        </p>
        <p>
          Khi khách hàng yêu cầu người bán cung cấp hoặc xoá dữ liệu của họ, Shopify chuyển yêu cầu tới ứng dụng: ứng dụng trao cho người bán bản xuất các
          đơn của khách, hoặc xoá các trường cá nhân trên các đơn đó nhưng giữ lại tổng ẩn danh mà sổ sách của người bán cần.
        </p>
      </Section>
      <Section heading="Bảo mật">
        <p>
          Dữ liệu được mã hoá khi truyền. Token nhà cung cấp được mã hoá khi lưu bằng AES-256-GCM. Truy cập ứng dụng đi qua đăng nhập và session token
          của chính Shopify; không có mật khẩu riêng.
        </p>
      </Section>
      <Section heading="Liên hệ">
        <p>Thắc mắc về chính sách này: {contact}.</p>
      </Section>
    </PublicPage>
  );
}
