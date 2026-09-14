import type { MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { LanguageDivider, PublicPage, Section } from "~/components/PublicPage";
import { env } from "~/lib/env.server";
import { aiEndpointStatus } from "~/services/ai-landing.server";
import {
  CLOSED_ORDER_PII_DAYS,
  EXPORT_RETENTION_DAYS,
  RETENTION_DAYS,
  STALE_ORDER_PII_DAYS,
  WEBHOOK_EVENT_RETENTION_DAYS,
} from "~/services/compliance.server";

export const meta: MetaFunction = () => [{ title: "Privacy policy · DropshipHub" }];

/**
 * A host name fit to print on a public page. aiEndpointStatus falls back to the
 * raw ANTHROPIC_BASE_URL when it does not parse as a URL, and that raw value is
 * operator configuration that could carry anything, so only a plain host (with
 * an optional port) is shown. Exported for tests.
 */
export function publicEndpointHost(host: string): string | null {
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host.toLowerCase() : null;
}

/**
 * The retention periods come from the code that enforces them, so the page
 * cannot promise one number while the job applies another. The AI endpoint is
 * read the same way: the SDK sends requests wherever ANTHROPIC_BASE_URL points,
 * and the page names that host rather than assuming Anthropic's own.
 */
export const loader = async () => {
  const ai = aiEndpointStatus();
  return {
    supportEmail: env().SUPPORT_EMAIL ?? null,
    updated: "2026-09-14",
    ai: { configured: ai.configured, direct: ai.direct, host: publicEndpointHost(ai.host) },
    days: {
      uninstalled: RETENTION_DAYS,
      closedOrder: CLOSED_ORDER_PII_DAYS,
      anyOrder: STALE_ORDER_PII_DAYS,
      export: EXPORT_RETENTION_DAYS,
      webhook: WEBHOOK_EVENT_RETENTION_DAYS,
    },
  };
};


/**
 * The privacy policy the App Store listing links to. It describes what the
 * app actually does with data, so it must change when the code does. The
 * previous version said customer data was never emailed while data-request
 * exports were mailed as JSON, and said Anthropic only saw variant option names
 * while landing-page rewrites sent whole product pages and images. It then said
 * the Chrome extension never touched customer data while the extension's order
 * list carries every recipient's address. Every
 * statement below was checked against the code on the date above; the list of
 * recipients is the complete set of places data leaves the app.
 */
export default function PrivacyPage() {
  const { supportEmail, updated, days, ai } = useLoaderData<typeof loader>();
  const endpoint = ai.host ? <code>{ai.host}</code> : null;
  const contact = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <span>the support address in the app listing</span>;
  const lienHe = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <span>địa chỉ hỗ trợ trong trang ứng dụng</span>;
  return (
    <PublicPage title="Privacy policy" subtitle={`Last updated ${updated}. Tiếng Việt ở phía dưới.`}>
      <Section heading="Who we are">
        <p>
          DropshipHub is a Shopify app that helps merchants import products from suppliers such as AliExpress and CJ Dropshipping, order those products
          for their Shopify orders and sync tracking back to Shopify. For AliExpress, the Chrome extension lists the orders waiting to be placed and opens
          each product on AliExpress. The merchant places and pays for the order there, then records the AliExpress order number in the extension;
          tracking added there is sent to Shopify. The merchant who installs the app decides why customer data is processed; the app processes it on the
          merchant's behalf. This policy explains what the app stores, why, who receives it and for how long.
        </p>
      </Section>

      <Section heading="What the app stores">
        <ul>
          <li>
            <strong>Store information</strong>: store name, domain, contact email, country, currency, timezone, primary location, the access token Shopify
            issues to the app, and the app's own settings for the store.
          </li>
          <li>
            <strong>People who use the app</strong>: the email address Shopify reports for the staff member signed in, the team members and roles the
            merchant adds under Staff, and an activity log of what was done in the app and by whom.
          </li>
          <li>
            <strong>Orders</strong>: order number, line items, totals, payment and fulfilment status and destination country for the store's orders.
            For an order the app can fulfil - one that contains a product the merchant manages in the app, or that already has a supplier order - it also
            stores the customer's name, email, phone, shipping address, order note and, for destinations that require one, a customs identifier (for
            example CPF in Brazil or RUT in Chile). Orders with no such product keep no name, email, phone or street address.
          </li>
          <li>
            <strong>Supplier orders</strong>: what was ordered from which supplier, costs, status, supplier order numbers, tracking numbers and carriers,
            and error messages the supplier returned.
          </li>
          <li>
            <strong>Products</strong>: products the merchant imports or links, their variants, prices, stock, descriptions and image links.
          </li>
          <li>
            <strong>Supplier accounts</strong>: the token or API key for any supplier account the merchant connects, encrypted at rest.
          </li>
          <li>
            <strong>Browser extension</strong>: the optional DropshipHub Chrome extension talks to the app with a per-store API token. It sends the
            product page the merchant is viewing on AliExpress or CJ Dropshipping to the app. It also shows the merchant the orders waiting to be placed,
            which includes each recipient's name, phone, shipping address and, where required, customs identifier, so the merchant can enter them on
            AliExpress; the app sends that list only to the extension, with caching disabled, and web pages cannot read it. What the merchant records in the
            extension - AliExpress order numbers, the order total, tracking numbers and carriers - is sent back to the app.
          </li>
          <li>
            <strong>Webhooks and notifications</strong>: copies of the webhooks Shopify sends the app (order webhooks contain customer details), and the
            in-app notifications the app raises.
          </li>
        </ul>
      </Section>

      <Section heading="Why">
        <p>
          Only to provide the app to the merchant: import and publish products, write product pages, match variants to supplier SKUs, place supplier
          orders for Shopify orders (which requires the recipient's shipping details), sync tracking and status back to Shopify, keep prices and stock in
          step with the supplier, report revenue, cost and profit, and answer customers' privacy requests. We do not sell data and do not use it for
          advertising.
        </p>
      </Section>

      <Section heading="Who receives it">
        <ul>
          <li>
            <strong>The supplier the merchant orders from</strong> (AliExpress or CJ Dropshipping) receives the recipient's name, shipping address,
            phone and, where required, customs identifier for each supplier order, because the supplier ships the parcel. On AliExpress the merchant
            enters these details when placing the order on the AliExpress site. The supplier's own privacy policy applies to that data.
          </li>
          <li>
            <strong>Shopify</strong> receives products, inventory, fulfilments and tracking numbers through the Admin API.
          </li>
          <li>
            <strong>Anthropic's Claude</strong>, only when a merchant uses an AI feature and the operator of DropshipHub has configured an AI key
            {ai.configured ? "" : " (AI features are not enabled at the moment)"}. For an AI landing-page rewrite it receives the product's title and
            description, its variant options and prices (with each variant's stock), the supplier store name, the store's name and public support
            email, and up to 8 image URLs, plus up to two of the store's own earlier rewritten product pages as style examples. For AI variant matching
            it receives the Shopify and supplier product titles, the variant option names and values, and the supplier SKUs' attributes and
            availability. Requests go to Claude either directly or through the AI endpoint the operator of DropshipHub configured.{" "}
            {endpoint ? (
              <>
                The endpoint currently configured is {endpoint}
                {ai.direct ? ", Anthropic's own API." : ", an Anthropic-compatible gateway run by a third party, which receives the same data."}
              </>
            ) : (
              "The endpoint currently configured is a custom address set by the operator."
            )}{" "}
            No order or customer data is sent.
          </li>
          <li>
            <strong>An email provider</strong> (Resend or an SMTP service), only when email is configured. It receives the address the merchant chose
            and the text of the notifications the merchant asked to be emailed, which name orders by number and can quote a supplier's error message.
            When a customer asks for their data, the merchant is emailed that a request arrived; the customer's data itself is not emailed and is
            downloaded inside the app.
          </li>
          <li>
            <strong>Our hosting and database provider</strong> stores all of the above on our behalf.
          </li>
        </ul>
      </Section>

      <Section heading="How long it is kept">
        <ul>
          <li>
            A customer's name, email, phone, address and order note are removed from an order {days.closedOrder} days after the order is fulfilled,
            cancelled or set aside and last changed, and from any order {days.anyOrder} days after it was placed. The anonymised order - totals, line
            items and country - stays for the merchant's reports while the app is installed. The merchant still has the full order in Shopify.
          </li>
          <li>When a supplier order's customer details are removed, the copy of the supplier's order response is removed with them.</li>
          <li>
            A webhook's contents are removed within a day of it being processed. An order or fulfilment webhook still waiting after a day is reduced to
            its ids; a pending privacy request is kept until it has been handled. Every webhook record is deleted after {days.webhook} days.
          </li>
          <li>An export prepared for a customer's data request is deleted {days.export} days after it was created.</li>
          <li>
            When a merchant uninstalls the app, Shopify asks the app to erase the store 48 hours later and the app deletes all of the store's data,
            including its access token and supplier tokens. Any store still uninstalled after {days.uninstalled} days is erased regardless.
          </li>
          <li>Other data - products, settings, the activity log and notifications - is kept while the app is installed.</li>
        </ul>
      </Section>

      <Section heading="Customers' privacy requests">
        <p>
          When a customer asks the merchant for their data, Shopify relays the request to the app. The app prepares an export of everything it holds
          about that customer's orders, which a store owner or admin downloads from Notifications inside the app. Every download is logged.
        </p>
        <p>
          When a customer asks for their data to be erased, Shopify relays that too. The app removes the customer's details from the named orders and
          from every copy it keeps: order issues, supplier order responses and errors, fulfilment request messages, activity log entries,
          notifications, earlier data-request exports and stored webhooks. The anonymised totals the merchant's accounts depend on are kept.
        </p>
      </Section>

      <Section heading="Security">
        <p>
          Traffic is encrypted in transit. Supplier tokens are encrypted at rest with AES-256-GCM. Access to the app runs through Shopify's own login and
          session tokens; there is no separate password. Team members can be given read-only or staff roles, and customer data exports are limited to
          owners and admins.
        </p>
      </Section>

      <Section heading="Contact">
        <p>Questions about this policy or a privacy request: {contact}.</p>
      </Section>

      <LanguageDivider label="Tiếng Việt" />

      <Section heading="Chính sách quyền riêng tư">
        <p>
          DropshipHub là ứng dụng Shopify giúp người bán nhập sản phẩm từ các nhà cung cấp như AliExpress và CJ Dropshipping, đặt mua các sản phẩm đó
          cho đơn hàng Shopify và đồng bộ mã vận đơn về Shopify. Với AliExpress, tiện ích Chrome liệt kê các đơn đang chờ đặt và mở từng sản phẩm trên
          AliExpress. Người bán tự đặt và thanh toán đơn ở đó, rồi ghi mã đơn AliExpress vào tiện ích; mã vận đơn nhập ở đó được gửi về Shopify. Người
          bán cài ứng dụng là người quyết định mục đích xử lý dữ liệu khách hàng; ứng dụng xử lý thay mặt người bán. Chính sách này nêu rõ ứng dụng lưu
          gì, vì sao, gửi cho ai và giữ trong bao lâu.
        </p>
      </Section>

      <Section heading="Ứng dụng lưu những gì">
        <ul>
          <li>
            <strong>Thông tin cửa hàng</strong>: tên, tên miền, email liên hệ, quốc gia, tiền tệ, múi giờ, địa điểm chính, access token Shopify cấp cho
            ứng dụng và phần cài đặt của ứng dụng cho cửa hàng.
          </li>
          <li>
            <strong>Người dùng ứng dụng</strong>: email Shopify báo cho nhân viên đang đăng nhập, các thành viên và vai trò người bán thêm ở mục Nhân
            viên, và nhật ký hoạt động ghi lại việc gì đã làm trong ứng dụng, do ai làm.
          </li>
          <li>
            <strong>Đơn hàng</strong>: số đơn, dòng sản phẩm, tổng tiền, trạng thái thanh toán/giao hàng và nước nhận của các đơn trong cửa hàng. Với đơn
            ứng dụng có thể xử lý - đơn có sản phẩm người bán quản lý trong ứng dụng, hoặc đã có đơn nhà cung cấp - ứng dụng lưu thêm tên, email, điện
            thoại, địa chỉ giao hàng, ghi chú đơn của khách và, với nước bắt buộc, mã số hải quan (ví dụ CPF ở Brazil, RUT ở Chile). Đơn không có sản
            phẩm như vậy không lưu tên, email, điện thoại hay địa chỉ.
          </li>
          <li>
            <strong>Đơn nhà cung cấp</strong>: đặt món gì ở nhà cung cấp nào, chi phí, trạng thái, mã đơn bên nhà cung cấp, mã vận đơn và hãng vận
            chuyển, cùng thông báo lỗi nhà cung cấp trả về.
          </li>
          <li>
            <strong>Sản phẩm</strong>: sản phẩm người bán nhập hoặc liên kết, biến thể, giá, tồn kho, mô tả và đường dẫn ảnh.
          </li>
          <li>
            <strong>Tài khoản nhà cung cấp</strong>: token hoặc API key của tài khoản nhà cung cấp người bán kết nối, được mã hoá khi lưu.
          </li>
          <li>
            <strong>Tiện ích trình duyệt</strong>: tiện ích Chrome DropshipHub (không bắt buộc) kết nối với ứng dụng bằng API token riêng của cửa hàng.
            Tiện ích gửi trang sản phẩm người bán đang xem trên AliExpress hoặc CJ Dropshipping về ứng dụng. Tiện ích cũng hiển thị cho người bán các
            đơn đang chờ đặt, gồm tên, điện thoại, địa chỉ giao hàng và, khi bắt buộc, mã số hải quan của người nhận, để người bán điền khi đặt trên
            AliExpress; ứng dụng chỉ gửi danh sách này tới tiện ích, có tắt lưu đệm, và trang web khác không đọc được. Những gì người bán ghi trong tiện ích -
            mã đơn AliExpress, tổng tiền đơn, mã vận đơn và hãng vận chuyển - được gửi về ứng dụng.
          </li>
          <li>
            <strong>Webhook và thông báo</strong>: bản sao các webhook Shopify gửi cho ứng dụng (webhook đơn hàng có thông tin khách) và các thông báo
            trong ứng dụng.
          </li>
        </ul>
      </Section>

      <Section heading="Mục đích">
        <p>
          Chỉ để cung cấp ứng dụng cho người bán: nhập và đăng sản phẩm, viết trang sản phẩm, ghép biến thể với SKU nhà cung cấp, đặt đơn nhà cung cấp
          cho đơn Shopify (cần thông tin giao hàng của người nhận), đồng bộ mã vận đơn và trạng thái về Shopify, cập nhật giá/tồn kho theo nhà cung cấp,
          báo cáo doanh thu, chi phí, lợi nhuận và xử lý yêu cầu quyền riêng tư của khách. Chúng tôi không bán dữ liệu và không dùng dữ liệu cho quảng
          cáo.
        </p>
      </Section>

      <Section heading="Ai nhận dữ liệu">
        <ul>
          <li>
            <strong>Nhà cung cấp người bán đặt hàng</strong> (AliExpress hoặc CJ Dropshipping) nhận tên, địa chỉ giao hàng, điện thoại và, khi bắt buộc,
            mã hải quan của người nhận cho mỗi đơn nhà cung cấp, vì nhà cung cấp là bên gửi hàng. Với AliExpress, người bán tự điền các thông tin này khi
            đặt đơn trên trang AliExpress. Chính sách riêng tư của nhà cung cấp áp dụng cho dữ liệu đó.
          </li>
          <li>
            <strong>Shopify</strong> nhận sản phẩm, tồn kho, fulfillment và mã vận đơn qua Admin API.
          </li>
          <li>
            <strong>Claude của Anthropic</strong>, chỉ khi người bán dùng tính năng AI và đơn vị vận hành DropshipHub đã cấu hình khoá AI
            {ai.configured ? "" : " (hiện tính năng AI chưa được bật)"}. Khi viết lại trang sản phẩm bằng AI, Claude nhận tiêu đề và mô tả sản phẩm, các
            tuỳ chọn biến thể và giá (kèm tồn kho từng biến thể), tên cửa hàng nhà cung cấp, tên cửa hàng và email hỗ trợ công khai của cửa hàng, tối đa 8
            đường dẫn ảnh, cùng tối đa hai trang sản phẩm đã viết lại trước đó của chính cửa hàng để làm mẫu văn phong. Khi ghép biến thể bằng AI, Claude
            nhận tiêu đề sản phẩm bên Shopify và bên nhà cung cấp, tên và giá trị tuỳ chọn biến thể, cùng thuộc tính và tình trạng còn hàng của các SKU
            nhà cung cấp. Yêu cầu được gửi tới Claude trực tiếp hoặc qua địa chỉ AI do đơn vị vận hành DropshipHub cấu hình.{" "}
            {endpoint ? (
              <>
                Địa chỉ đang được cấu hình là {endpoint}
                {ai.direct ? ", tức API của chính Anthropic." : ", một cổng tương thích Anthropic do bên thứ ba vận hành và cũng nhận đúng dữ liệu này."}
              </>
            ) : (
              "Địa chỉ đang được cấu hình là một địa chỉ riêng do đơn vị vận hành đặt."
            )}{" "}
            Không gửi dữ liệu đơn hàng hay khách hàng.
          </li>
          <li>
            <strong>Dịch vụ gửi email</strong> (Resend hoặc dịch vụ SMTP), chỉ khi email được cấu hình. Dịch vụ nhận địa chỉ người bán chọn và nội dung
            các thông báo người bán muốn nhận qua email; nội dung ghi đơn theo số đơn và có thể trích thông báo lỗi của nhà cung cấp. Khi khách yêu cầu dữ
            liệu của họ, người bán nhận email báo có yêu cầu; bản thân dữ liệu khách không gửi qua email mà được tải về trong ứng dụng.
          </li>
          <li>
            <strong>Nhà cung cấp hosting và cơ sở dữ liệu</strong> của chúng tôi lưu toàn bộ dữ liệu trên thay mặt chúng tôi.
          </li>
        </ul>
      </Section>

      <Section heading="Thời gian lưu">
        <ul>
          <li>
            Tên, email, điện thoại, địa chỉ và ghi chú của khách được xoá khỏi đơn {days.closedOrder} ngày sau khi đơn đã giao, đã huỷ hoặc được bỏ qua và
            không thay đổi nữa, và khỏi mọi đơn {days.anyOrder} ngày sau khi đặt. Đơn đã ẩn danh - tổng tiền, dòng sản phẩm và nước nhận - được giữ cho báo
            cáo của người bán khi ứng dụng còn được cài. Người bán vẫn có đầy đủ đơn trong Shopify.
          </li>
          <li>Khi thông tin khách trên một đơn nhà cung cấp bị xoá, bản sao phản hồi đơn hàng của nhà cung cấp cũng bị xoá theo.</li>
          <li>
            Nội dung webhook bị xoá trong vòng một ngày sau khi xử lý xong. Webhook đơn hàng hoặc giao hàng còn chờ sau một ngày được rút gọn chỉ còn mã
            định danh; yêu cầu quyền riêng tư đang chờ được giữ nguyên cho tới khi xử lý xong. Mọi bản ghi webhook bị xoá sau {days.webhook} ngày.
          </li>
          <li>Bản xuất dữ liệu chuẩn bị cho yêu cầu của khách bị xoá {days.export} ngày sau khi tạo.</li>
          <li>
            Khi người bán gỡ ứng dụng, 48 giờ sau Shopify yêu cầu ứng dụng xoá cửa hàng và ứng dụng xoá toàn bộ dữ liệu của cửa hàng, gồm cả access token
            và token nhà cung cấp. Cửa hàng nào vẫn ở trạng thái đã gỡ sau {days.uninstalled} ngày sẽ tự động bị xoá.
          </li>
          <li>Dữ liệu khác - sản phẩm, cài đặt, nhật ký hoạt động và thông báo - được giữ khi ứng dụng còn được cài.</li>
        </ul>
      </Section>

      <Section heading="Yêu cầu quyền riêng tư của khách">
        <p>
          Khi khách yêu cầu người bán cung cấp dữ liệu của họ, Shopify chuyển yêu cầu tới ứng dụng. Ứng dụng chuẩn bị bản xuất mọi thứ đang lưu về các
          đơn của khách đó; chủ cửa hàng hoặc quản trị viên tải về ở mục Thông báo trong ứng dụng. Mỗi lần tải đều được ghi nhật ký.
        </p>
        <p>
          Khi khách yêu cầu xoá dữ liệu, Shopify cũng chuyển yêu cầu tới ứng dụng. Ứng dụng xoá thông tin của khách trên các đơn được nêu và trên mọi bản
          sao đang giữ: lỗi địa chỉ của đơn, phản hồi và lỗi của nhà cung cấp, lời nhắn yêu cầu fulfillment, nhật ký hoạt động, thông báo, bản xuất dữ
          liệu trước đó và webhook đã lưu. Tổng tiền đã ẩn danh mà sổ sách của người bán cần vẫn được giữ.
        </p>
      </Section>

      <Section heading="Bảo mật">
        <p>
          Dữ liệu được mã hoá khi truyền. Token nhà cung cấp được mã hoá khi lưu bằng AES-256-GCM. Truy cập ứng dụng đi qua đăng nhập và session token
          của chính Shopify; không có mật khẩu riêng. Thành viên nhóm có thể được giao vai trò chỉ xem hoặc nhân viên, và chỉ chủ cửa hàng hoặc quản trị
          viên mới tải được bản xuất dữ liệu khách hàng.
        </p>
      </Section>

      <Section heading="Liên hệ">
        <p>Thắc mắc về chính sách này hoặc yêu cầu quyền riêng tư: {lienHe}.</p>
      </Section>
    </PublicPage>
  );
}
