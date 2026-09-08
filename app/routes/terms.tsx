import type { MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { LanguageDivider, PublicPage, Section } from "~/components/PublicPage";
import { PLANS, PLAN_ORDER } from "~/domain/billing/plans";
import { env } from "~/lib/env.server";

export const meta: MetaFunction = () => [{ title: "Terms of service · DropshipHub" }];

export const loader = async () => ({
  supportEmail: env().SUPPORT_EMAIL ?? null,
  updated: "2026-09-08",
  plans: PLAN_ORDER.map((id) => ({ name: PLANS[id].displayName, price: PLANS[id].monthlyPrice, trialDays: PLANS[id].trialDays })),
});

export default function TermsPage() {
  const { supportEmail, updated, plans } = useLoaderData<typeof loader>();
  const contact = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <span>the support address in the app listing</span>;
  const priceList = plans.map((p) => `${p.name}: ${p.price === 0 ? "free" : `US$${p.price.toFixed(2)} per 30 days`}${p.trialDays ? ` (${p.trialDays}-day free trial)` : ""}`);
  const priceListVi = plans.map((p) => `${p.name}: ${p.price === 0 ? "miễn phí" : `US$${p.price.toFixed(2)} mỗi 30 ngày`}${p.trialDays ? ` (dùng thử ${p.trialDays} ngày)` : ""}`);
  return (
    <PublicPage title="Terms of service" subtitle={`Last updated ${updated}. Tiếng Việt ở phía dưới.`}>
      <Section heading="The service">
        <p>
          DropshipHub ("the app") is software that connects a Shopify store to dropshipping suppliers. By installing it you agree to these terms. The app
          places orders with suppliers on your instruction, using supplier accounts you connect; the contract for each supplier order is between you and the
          supplier.
        </p>
      </Section>
      <Section heading="Your responsibilities">
        <ul>
          <li>You are responsible for the supplier accounts you connect and for complying with the supplier's and Shopify's terms.</li>
          <li>Supplier orders are paid by you on the supplier's site. The app never charges your supplier account and does not hold funds.</li>
          <li>You are responsible for the products you list, their descriptions, pricing and legality in the markets you sell to.</li>
          <li>Automatic actions (auto-place, auto price and stock updates) run on the rules you configure; review them before enabling.</li>
        </ul>
      </Section>
      <Section heading="Plans and billing">
        <p>Plans are billed through Shopify's own billing on your Shopify invoice. Current plans:</p>
        <ul>
          {priceList.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>
          You can change or cancel a plan at any time under Settings → Plan; downgrading keeps your data and stops further additions beyond the new plan's
          limits. Charges already billed by Shopify are not refunded except where Shopify's policies require it.
        </p>
      </Section>
      <Section heading="Availability and warranty">
        <p>
          The app is provided as is. We aim for continuous availability but do not guarantee it, and we do not guarantee that a supplier will accept, ship
          or deliver any order, or that supplier prices, stock or delivery times shown in the app are accurate — they come from the supplier and change
          without notice.
        </p>
      </Section>
      <Section heading="Liability">
        <p>
          To the extent permitted by law, our liability for any claim arising from the app is limited to the plan fees you paid in the three months before
          the claim. We are not liable for lost profits, lost orders, supplier disputes or customs charges.
        </p>
      </Section>
      <Section heading="Termination">
        <p>
          Uninstalling the app ends the agreement; your data is erased as described in the privacy policy. We may suspend an installation that abuses the
          service or the supplier APIs it relies on.
        </p>
      </Section>
      <Section heading="Changes and contact">
        <p>We may update these terms; material changes are announced in the app. Questions: {contact}.</p>
      </Section>

      <LanguageDivider label="Tiếng Việt" />

      <Section heading="Điều khoản dịch vụ">
        <p>
          DropshipHub ("ứng dụng") là phần mềm kết nối cửa hàng Shopify với các nhà cung cấp dropshipping. Cài ứng dụng là bạn đồng ý với các điều khoản
          này. Ứng dụng đặt đơn với nhà cung cấp theo chỉ dẫn của bạn, bằng tài khoản nhà cung cấp bạn kết nối; hợp đồng cho mỗi đơn nhà cung cấp là giữa bạn
          và nhà cung cấp.
        </p>
      </Section>
      <Section heading="Trách nhiệm của bạn">
        <ul>
          <li>Bạn chịu trách nhiệm về tài khoản nhà cung cấp bạn kết nối và việc tuân thủ điều khoản của nhà cung cấp và Shopify.</li>
          <li>Đơn nhà cung cấp do bạn thanh toán trên trang của nhà cung cấp. Ứng dụng không bao giờ trừ tiền tài khoản nhà cung cấp của bạn và không giữ tiền.</li>
          <li>Bạn chịu trách nhiệm về sản phẩm bạn đăng bán, mô tả, giá và tính hợp pháp tại thị trường bạn bán.</li>
          <li>Các thao tác tự động (tự đặt đơn, tự cập nhật giá/tồn kho) chạy theo quy tắc bạn cấu hình; hãy xem kỹ trước khi bật.</li>
        </ul>
      </Section>
      <Section heading="Gói và thanh toán">
        <p>Gói được tính phí qua hệ thống thanh toán của Shopify, trên hoá đơn Shopify của bạn. Các gói hiện có:</p>
        <ul>
          {priceListVi.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>
          Bạn có thể đổi hoặc huỷ gói bất kỳ lúc nào trong Cài đặt → Gói dịch vụ; hạ gói vẫn giữ dữ liệu và chỉ ngừng thêm mới vượt giới hạn của gói mới.
          Phí Shopify đã tính không được hoàn lại trừ khi chính sách của Shopify yêu cầu.
        </p>
      </Section>
      <Section heading="Tính sẵn sàng và bảo đảm">
        <p>
          Ứng dụng được cung cấp nguyên trạng. Chúng tôi hướng tới hoạt động liên tục nhưng không bảo đảm điều đó, và không bảo đảm nhà cung cấp sẽ nhận,
          gửi hay giao bất kỳ đơn nào, hoặc giá, tồn kho, thời gian giao hiển thị trong ứng dụng là chính xác — chúng đến từ nhà cung cấp và có thể đổi mà
          không báo trước.
        </p>
      </Section>
      <Section heading="Giới hạn trách nhiệm">
        <p>
          Trong phạm vi pháp luật cho phép, trách nhiệm của chúng tôi với mọi khiếu nại phát sinh từ ứng dụng giới hạn ở phí gói bạn đã trả trong ba tháng
          trước khiếu nại. Chúng tôi không chịu trách nhiệm về lợi nhuận mất, đơn mất, tranh chấp với nhà cung cấp hay phí hải quan.
        </p>
      </Section>
      <Section heading="Chấm dứt">
        <p>
          Gỡ ứng dụng là chấm dứt thoả thuận; dữ liệu của bạn được xoá như mô tả trong chính sách quyền riêng tư. Chúng tôi có thể tạm dừng bản cài đặt lạm
          dụng dịch vụ hoặc API nhà cung cấp mà dịch vụ dựa vào.
        </p>
      </Section>
      <Section heading="Thay đổi và liên hệ">
        <p>Chúng tôi có thể cập nhật điều khoản; thay đổi quan trọng được thông báo trong ứng dụng. Thắc mắc: {contact}.</p>
      </Section>
    </PublicPage>
  );
}
