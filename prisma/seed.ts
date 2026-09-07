/**
 * Development seed: a demo shop with pricing rules, shipping preferences,
 * an inventory policy, a mock supplier account, a few imported products and
 * a couple of orders, so every screen has data.
 *
 *   DATABASE_URL=... npm run db:seed [-- --shop my-dev-store.myshopify.com]
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const domainArg = process.argv.indexOf("--shop");
  const domain = domainArg >= 0 ? process.argv[domainArg + 1] : "demo-store.myshopify.com";

  const account = await prisma.account.upsert({
    where: { id: "seed-account" },
    create: { id: "seed-account", name: "Demo account", ownerEmail: "owner@example.com", plan: "PRO" },
    update: {},
  });

  const shop = await prisma.shop.upsert({
    where: { domain },
    create: {
      domain,
      accountId: account.id,
      name: "Demo Store",
      email: "owner@example.com",
      country: "US",
      currency: "USD",
      timezone: "America/New_York",
      primaryLocationId: "gid://shopify/Location/1",
      onboardingStep: "done",
      inventoryPolicy: { create: { priceAction: "NOTIFY_ONLY", stockAction: "SET_ZERO_WHEN_OUT", syncIntervalMinutes: 360 } },
    },
    update: { accountId: account.id },
  });

  await prisma.supplierAccount.upsert({
    where: { id: "seed-mock-account" },
    create: { id: "seed-mock-account", accountId: account.id, shopId: null, platform: "MOCK", label: "Sample catalog", isDefault: true },
    update: {},
  });

  const existingRules = await prisma.pricingRule.count({ where: { shopId: shop.id } });
  if (existingRules === 0) {
    await prisma.pricingRule.create({
      data: {
        shopId: shop.id,
        name: "Tiered markup",
        description: "Higher multiplier on cheap items, lower on expensive ones.",
        isDefault: true,
        basePriceOp: "MULTIPLY",
        basePriceValue: "1.8",
        compareAtOp: "MULTIPLY",
        compareAtValue: "1.35",
        centsEnding: 99,
        tiers: {
          create: [
            { minCost: "0", maxCost: "5", priceOp: "MULTIPLY", priceValue: "3", compareAtOp: "MULTIPLY", compareAtValue: "1.5" },
            { minCost: "5", maxCost: "20", priceOp: "MULTIPLY", priceValue: "2.2", compareAtOp: "MULTIPLY", compareAtValue: "1.4" },
            { minCost: "20", maxCost: null, priceOp: "MARGIN", priceValue: "45", compareAtOp: "MULTIPLY", compareAtValue: "1.25" },
          ],
        },
      },
    });
    await prisma.pricingRule.create({
      data: { shopId: shop.id, name: "Flat 2x", basePriceOp: "MULTIPLY", basePriceValue: "2", centsEnding: 99 },
    });
  }

  for (const pref of [
    { countryCode: "US", carrierCode: "EPACKET", carrierName: "ePacket", priority: 0, requireTracking: true },
    { countryCode: "US", carrierCode: "CAINIAO_STANDARD", carrierName: "AliExpress Standard Shipping", priority: 1, requireTracking: true },
    { countryCode: "*", carrierCode: "CAINIAO_STANDARD", carrierName: "AliExpress Standard Shipping", priority: 0, requireTracking: true },
    { countryCode: "*", carrierCode: "YANWEN", carrierName: "Yanwen Economic Air Mail", priority: 1, requireTracking: false },
  ]) {
    await prisma.shippingPreference.upsert({
      where: { shopId_countryCode_carrierCode: { shopId: shop.id, countryCode: pref.countryCode, carrierCode: pref.carrierCode } },
      create: { shopId: shop.id, ...pref },
      update: pref,
    });
  }

  // Imported products from the mock catalog (services are not used here to keep the seed dependency-free).
  const catalog = [
    { externalId: "1005006001", title: "Wireless Bluetooth Earbuds Pro, Noise Cancelling, 48H Battery", options: ["Color"], values: [["Black"], ["White"], ["Navy"]], cost: 9.8 },
    { externalId: "1005006003", title: "Portable Blender USB Rechargeable 380ml Fresh Juice Cup", options: ["Color"], values: [["Pink"], ["Green"], ["Blue"]], cost: 7.2 },
    { externalId: "1005006008", title: "Yoga Mat Non-Slip 6mm TPE Eco Friendly", options: ["Color"], values: [["Purple"], ["Teal"], ["Grey"]], cost: 8.9 },
  ];
  for (const item of catalog) {
    const supplierProduct = await prisma.supplierProduct.upsert({
      where: { platform_externalId: { platform: "ALIEXPRESS", externalId: item.externalId } },
      create: {
        platform: "ALIEXPRESS",
        externalId: item.externalId,
        title: item.title,
        url: `https://www.aliexpress.com/item/${item.externalId}.html`,
        storeName: "Demo Supplier",
        rating: 4.7,
        orderCount: 12000,
        images: [`https://placehold.co/800x800?text=${item.externalId}`],
        shipsFrom: ["CN"],
        variants: {
          create: item.values.map((values, i) => ({
            externalSkuId: `${item.externalId}-${i + 1}`,
            attributes: values.map((value, j) => ({ name: item.options[j], value })),
            price: (item.cost * (1 + i * 0.05)).toFixed(2),
            stock: 120,
            isAvailable: true,
          })),
        },
      },
      update: {},
      include: { variants: true },
    });
    await prisma.importedProduct.upsert({
      where: { shopId_supplierProductId: { shopId: shop.id, supplierProductId: supplierProduct.id } },
      create: {
        shopId: shop.id,
        supplierProductId: supplierProduct.id,
        title: item.title,
        description: `<p>${item.title}</p>`,
        vendor: "Demo Supplier",
        tags: ["dropship"],
        images: supplierProduct.images,
        options: item.options,
        variants: {
          create: supplierProduct.variants.map((v, i) => ({
            supplierVariantId: v.id,
            title: item.values[i].join(" / "),
            optionValues: item.values[i],
            cost: v.price,
            price: (Number(v.price) * 2.2).toFixed(0) + ".99",
            compareAtPrice: (Number(v.price) * 3).toFixed(0) + ".99",
            inventory: 50,
          })),
        },
      },
      update: {},
    });
  }

  await prisma.activityLog.create({ data: { shopId: shop.id, action: "seed", message: "Demo data seeded." } });
  await prisma.notification.create({ data: { shopId: shop.id, type: "system", title: "Welcome to DropshipHub", body: "Demo data is loaded. Connect a real supplier under Suppliers when you are ready." } });

  console.info(`Seeded shop ${domain} (id ${shop.id}).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
