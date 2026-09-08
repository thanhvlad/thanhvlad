import type { MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { LanguageDivider, PublicPage, Section } from "~/components/PublicPage";
import { env } from "~/lib/env.server";

export const meta: MetaFunction = () => [{ title: "Support · DropshipHub" }];

export const loader = async () => ({ supportEmail: env().SUPPORT_EMAIL ?? null });

export default function SupportPage() {
  const { supportEmail } = useLoaderData<typeof loader>();
  const contact = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <span>the support address in the app listing</span>;
  return (
    <PublicPage title="Support" subtitle="Answers to the questions merchants ask most. Tiếng Việt ở phía dưới.">
      <Section heading="Contact">
        <p>
          Email {contact} with your store domain and, for an order problem, the order number. Replies within one business day. From inside the app,
          Settings → Support has the same links plus your deployment's status.
        </p>
      </Section>
      <Section heading="Connecting AliExpress">
        <p>
          Suppliers → AliExpress → Connect opens AliExpress's own login. Sign in with the AliExpress account you buy from; the app stores an encrypted token
          and never sees your password. If the connection expires, a notification tells you to reconnect.
        </p>
      </Section>
      <Section heading={'Why is my order "awaiting payment"?'}>
        <p>
          The app placed the supplier order and AliExpress is waiting for you to pay it — AliExpress does not let apps charge your account. Open Payments,
          click Pay to open that exact order on AliExpress, and pay there. AliExpress cancels unpaid orders after 24 hours, so the Payments page counts down.
          The app notices the payment on its next check, or use "I paid this".
        </p>
      </Section>
      <Section heading="The Request fulfillment button">
        <p>
          Settings → Fulfilment service registers the app as a fulfilment service in Shopify. Products stocked at the app's location then show Request
          fulfillment on the Shopify order page; clicking it sends the order here and places it with the supplier. Unmapped lines are rejected back with the
          reason.
        </p>
      </Section>
      <Section heading="Tracking numbers">
        <p>
          Every 15 minutes the app asks the supplier for new tracking numbers and, when it finds one, creates the Shopify fulfilment and (if enabled) emails
          your customer. A supplier order that ships as several parcels puts every number on the one fulfilment.
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
          Gửi email tới {contact} kèm tên miền cửa hàng và, nếu là vấn đề đơn hàng, số đơn. Phản hồi trong một ngày làm việc. Trong ứng dụng, Cài đặt → Hỗ trợ
          có các liên kết tương tự cùng trạng thái hệ thống.
        </p>
      </Section>
      <Section heading="Kết nối AliExpress">
        <p>
          Nhà cung cấp → AliExpress → Kết nối sẽ mở trang đăng nhập của chính AliExpress. Đăng nhập bằng tài khoản AliExpress bạn dùng để mua; ứng dụng lưu
          token đã mã hoá và không bao giờ thấy mật khẩu của bạn. Nếu kết nối hết hạn, sẽ có thông báo nhắc kết nối lại.
        </p>
      </Section>
      <Section heading={'Vì sao đơn ở trạng thái "chờ thanh toán"?'}>
        <p>
          Ứng dụng đã đặt đơn nhà cung cấp và AliExpress đang chờ bạn thanh toán — AliExpress không cho phép ứng dụng trừ tiền tài khoản của bạn. Mở Thanh
          toán, bấm Thanh toán để mở đúng đơn đó trên AliExpress và trả tiền ở đó. AliExpress huỷ đơn chưa trả sau 24 giờ nên trang Thanh toán có đếm ngược.
          Ứng dụng sẽ nhận ra khoản thanh toán ở lần kiểm tra kế tiếp, hoặc bấm "Tôi đã trả".
        </p>
      </Section>
      <Section heading="Nút Request fulfillment">
        <p>
          Cài đặt → Dịch vụ giao hàng đăng ký ứng dụng làm fulfillment service trong Shopify. Sản phẩm để tồn kho ở địa điểm của ứng dụng sẽ có nút Request
          fulfillment trên trang đơn hàng Shopify; bấm nút là đơn được gửi sang đây và đặt với nhà cung cấp. Dòng chưa ghép sẽ bị trả lại kèm lý do.
        </p>
      </Section>
      <Section heading="Mã vận đơn">
        <p>
          Cứ 15 phút ứng dụng hỏi nhà cung cấp mã vận đơn mới và khi có, tạo fulfillment trên Shopify và (nếu bật) gửi email cho khách. Đơn nhà cung cấp gửi
          thành nhiều kiện sẽ có đủ mã trên cùng một fulfillment.
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
