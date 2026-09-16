-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'ADVANCED', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'STAFF', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "SupplierPlatform" AS ENUM ('ALIEXPRESS', 'CJ_DROPSHIPPING', 'TEMU', 'MANUAL', 'MOCK');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('DRAFT', 'READY', 'PUSHING', 'PUSHED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MappingType" AS ENUM ('BASIC', 'ADVANCED', 'BOGO', 'BUNDLE');

-- CreateEnum
CREATE TYPE "PriceOp" AS ENUM ('MULTIPLY', 'ADD', 'MARGIN', 'FIXED', 'NONE');

-- CreateEnum
CREATE TYPE "PriceChangeAction" AS ENUM ('DO_NOTHING', 'UPDATE_PRICE', 'NOTIFY_ONLY');

-- CreateEnum
CREATE TYPE "StockChangeAction" AS ENUM ('DO_NOTHING', 'UPDATE_QUANTITY', 'SET_ZERO_WHEN_OUT', 'UNPUBLISH_WHEN_OUT', 'NOTIFY_ONLY');

-- CreateEnum
CREATE TYPE "OrderStage" AS ENUM ('PENDING', 'AWAITING_ORDER', 'AWAITING_PAYMENT', 'AWAITING_SHIPMENT', 'AWAITING_DELIVERY', 'FULFILLED', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SUBMITTING', 'PLACED', 'AWAITING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerEmail" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "planRenewsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "country" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "primaryLocationId" TEXT,
    "moneyFormat" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "onboardingStep" TEXT NOT NULL DEFAULT 'connect_supplier',
    "apiToken" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "StaffRole" NOT NULL DEFAULT 'STAFF',
    "shopScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "StaffAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shopId" TEXT,
    "platform" "SupplierPlatform" NOT NULL,
    "label" TEXT NOT NULL,
    "externalUserId" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL,
    "platform" "SupplierPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "supplierAccountId" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "storeName" TEXT,
    "storeUrl" TEXT,
    "storeId" TEXT,
    "rating" DOUBLE PRECISION,
    "orderCount" INTEGER,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryId" TEXT,
    "shipsFrom" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "lastFetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierVariant" (
    "id" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "externalSkuId" TEXT NOT NULL,
    "skuAttr" TEXT,
    "sku" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '[]',
    "image" TEXT,
    "price" DECIMAL(18,4) NOT NULL,
    "originalPrice" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierShippingOption" (
    "id" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "shipFromCountry" TEXT NOT NULL DEFAULT 'CN',
    "shipToCountry" TEXT NOT NULL,
    "carrierCode" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "cost" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "minDeliveryDays" INTEGER,
    "maxDeliveryDays" INTEGER,
    "hasTracking" BOOLEAN NOT NULL DEFAULT true,
    "isFreeShipping" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierShippingOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "supplierProductId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "vendor" TEXT,
    "productType" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "handle" TEXT,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "options" JSONB NOT NULL DEFAULT '[]',
    "excludedValues" JSONB NOT NULL DEFAULT '{}',
    "status" "ImportStatus" NOT NULL DEFAULT 'DRAFT',
    "pushedProductId" TEXT,
    "pushError" TEXT,
    "pushedAt" TIMESTAMP(3),
    "pricingRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedVariant" (
    "id" TEXT NOT NULL,
    "importedProductId" TEXT NOT NULL,
    "supplierVariantId" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "optionValues" JSONB NOT NULL DEFAULT '[]',
    "image" TEXT,
    "cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shippingCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "price" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "compareAtPrice" DECIMAL(18,4),
    "weightGrams" INTEGER,
    "inventory" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "vendor" TEXT,
    "featuredImage" TEXT,
    "autoUpdateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "costOfGoods" DECIMAL(18,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "optionValues" JSONB NOT NULL DEFAULT '[]',
    "price" DECIMAL(18,4) NOT NULL,
    "compareAtPrice" DECIMAL(18,4),
    "cost" DECIMAL(18,4),
    "inventoryQuantity" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "MappingType" NOT NULL DEFAULT 'BASIC',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantMapping" (
    "id" TEXT NOT NULL,
    "productMappingId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "supplierVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "shipToCountry" TEXT NOT NULL DEFAULT '*',
    "shipFromCountry" TEXT,
    "minQuantity" INTEGER,
    "maxQuantity" INTEGER,
    "bundleGroup" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "basePriceOp" "PriceOp" NOT NULL DEFAULT 'MULTIPLY',
    "basePriceValue" DECIMAL(18,4) NOT NULL DEFAULT 2,
    "compareAtOp" "PriceOp" NOT NULL DEFAULT 'NONE',
    "compareAtValue" DECIMAL(18,4),
    "centsEnding" INTEGER,
    "roundToMultiple" DECIMAL(18,4),
    "includeShipping" BOOLEAN NOT NULL DEFAULT false,
    "minPrice" DECIMAL(18,4),
    "maxPrice" DECIMAL(18,4),
    "syncCostOfGoods" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRuleTier" (
    "id" TEXT NOT NULL,
    "pricingRuleId" TEXT NOT NULL,
    "minCost" DECIMAL(18,4) NOT NULL,
    "maxCost" DECIMAL(18,4),
    "priceOp" "PriceOp" NOT NULL DEFAULT 'MULTIPLY',
    "priceValue" DECIMAL(18,4) NOT NULL,
    "compareAtOp" "PriceOp" NOT NULL DEFAULT 'NONE',
    "compareAtValue" DECIMAL(18,4),

    CONSTRAINT "PricingRuleTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingPreference" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT '*',
    "carrierCode" TEXT NOT NULL,
    "carrierName" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "maxCost" DECIMAL(18,4),
    "maxDeliveryDays" INTEGER,
    "requireTracking" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPolicy" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "priceAction" "PriceChangeAction" NOT NULL DEFAULT 'NOTIFY_ONLY',
    "priceThresholdPercent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "stockAction" "StockChangeAction" NOT NULL DEFAULT 'SET_ZERO_WHEN_OUT',
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
    "maxInventoryPushed" INTEGER NOT NULL DEFAULT 50,
    "onProductRemoved" "StockChangeAction" NOT NULL DEFAULT 'UNPUBLISH_WHEN_OUT',
    "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 360,
    "lastRunAt" TIMESTAMP(3),
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orderNumber" INTEGER,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "stage" "OrderStage" NOT NULL DEFAULT 'PENDING',
    "customerName" TEXT,
    "customerEmail" TEXT,
    "phone" TEXT,
    "shippingAddress" JSONB NOT NULL DEFAULT '{}',
    "countryCode" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalPrice" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalShipping" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalTax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalDiscount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "supplierCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "supplierShipping" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "riskLevel" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "placedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "shopifyCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "productVariantId" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "image" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "fulfillableQuantity" INTEGER NOT NULL DEFAULT 1,
    "price" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalDiscount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "resolution" JSONB NOT NULL DEFAULT '{}',
    "isFulfilled" BOOLEAN NOT NULL DEFAULT false,
    "isCanceled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supplierAccountId" TEXT,
    "platform" "SupplierPlatform" NOT NULL,
    "externalOrderId" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "itemsCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shippingCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "carrierCode" TEXT,
    "carrierName" TEXT,
    "shipFromCountry" TEXT,
    "estimatedDeliveryDays" INTEGER,
    "supplierNote" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "placedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "orderLineItemId" TEXT,
    "supplierVariantId" TEXT,
    "externalProductId" TEXT,
    "externalSkuId" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingNumber" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "carrierCode" TEXT,
    "carrierName" TEXT,
    "trackingUrl" TEXT,
    "syncedToShopify" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3),
    "shopifyFulfillmentId" TEXT,
    "syncError" TEXT,
    "notifyCustomer" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "queueJobId" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "topic" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrencyRate" (
    "id" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurrencyRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPriceSnapshot" (
    "id" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "externalSkuId" TEXT NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMetric" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "itemsSold" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "productCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shippingCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "profit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "ordersPlaced" INTEGER NOT NULL DEFAULT 0,
    "ordersFulfilled" INTEGER NOT NULL DEFAULT 0,
    "ordersFailed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_apiToken_key" ON "Shop"("apiToken");

-- CreateIndex
CREATE INDEX "Shop_accountId_idx" ON "Shop"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAccount_accountId_email_key" ON "StaffAccount"("accountId", "email");

-- CreateIndex
CREATE INDEX "SupplierAccount_accountId_platform_idx" ON "SupplierAccount"("accountId", "platform");

-- CreateIndex
CREATE INDEX "SupplierAccount_shopId_idx" ON "SupplierAccount"("shopId");

-- CreateIndex
CREATE INDEX "SupplierProduct_platform_isAvailable_idx" ON "SupplierProduct"("platform", "isAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_platform_externalId_key" ON "SupplierProduct"("platform", "externalId");

-- CreateIndex
CREATE INDEX "SupplierVariant_supplierProductId_idx" ON "SupplierVariant"("supplierProductId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierVariant_supplierProductId_externalSkuId_key" ON "SupplierVariant"("supplierProductId", "externalSkuId");

-- CreateIndex
CREATE INDEX "SupplierShippingOption_supplierProductId_shipToCountry_idx" ON "SupplierShippingOption"("supplierProductId", "shipToCountry");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierShippingOption_supplierProductId_shipFromCountry_sh_key" ON "SupplierShippingOption"("supplierProductId", "shipFromCountry", "shipToCountry", "carrierCode");

-- CreateIndex
CREATE INDEX "ImportedProduct_shopId_status_idx" ON "ImportedProduct"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedProduct_shopId_supplierProductId_key" ON "ImportedProduct"("shopId", "supplierProductId");

-- CreateIndex
CREATE INDEX "ImportedVariant_importedProductId_idx" ON "ImportedVariant"("importedProductId");

-- CreateIndex
CREATE INDEX "Product_shopId_idx" ON "Product"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_shopifyProductId_key" ON "Product"("shopId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ProductVariant_shopifyVariantId_idx" ON "ProductVariant"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_shopifyVariantId_key" ON "ProductVariant"("productId", "shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_productId_key" ON "ProductMapping"("productId");

-- CreateIndex
CREATE INDEX "VariantMapping_productMappingId_idx" ON "VariantMapping"("productMappingId");

-- CreateIndex
CREATE INDEX "VariantMapping_productVariantId_shipToCountry_priority_idx" ON "VariantMapping"("productVariantId", "shipToCountry", "priority");

-- CreateIndex
CREATE INDEX "PricingRule_shopId_idx" ON "PricingRule"("shopId");

-- CreateIndex
CREATE INDEX "PricingRuleTier_pricingRuleId_minCost_idx" ON "PricingRuleTier"("pricingRuleId", "minCost");

-- CreateIndex
CREATE INDEX "ShippingPreference_shopId_countryCode_priority_idx" ON "ShippingPreference"("shopId", "countryCode", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingPreference_shopId_countryCode_carrierCode_key" ON "ShippingPreference"("shopId", "countryCode", "carrierCode");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPolicy_shopId_key" ON "InventoryPolicy"("shopId");

-- CreateIndex
CREATE INDEX "Order_shopId_stage_idx" ON "Order"("shopId", "stage");

-- CreateIndex
CREATE INDEX "Order_shopId_shopifyCreatedAt_idx" ON "Order"("shopId", "shopifyCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_shopifyOrderId_key" ON "Order"("shopId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderLineItem_orderId_idx" ON "OrderLineItem"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_orderId_shopifyLineItemId_key" ON "OrderLineItem"("orderId", "shopifyLineItemId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_orderId_idx" ON "PurchaseOrder"("orderId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_platform_externalOrderId_idx" ON "PurchaseOrder"("platform", "externalOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "TrackingNumber_syncedToShopify_idx" ON "TrackingNumber"("syncedToShopify");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingNumber_purchaseOrderId_number_key" ON "TrackingNumber"("purchaseOrderId", "number");

-- CreateIndex
CREATE INDEX "JobRun_shopId_type_status_idx" ON "JobRun"("shopId", "type", "status");

-- CreateIndex
CREATE INDEX "JobRun_status_idx" ON "JobRun"("status");

-- CreateIndex
CREATE INDEX "ActivityLog_shopId_createdAt_idx" ON "ActivityLog"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_shopId_entity_entityId_idx" ON "ActivityLog"("shopId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "Notification_shopId_readAt_idx" ON "Notification"("shopId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_topic_createdAt_idx" ON "WebhookEvent"("topic", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CurrencyRate_base_quote_key" ON "CurrencyRate"("base", "quote");

-- CreateIndex
CREATE INDEX "SupplierPriceSnapshot_supplierProductId_externalSkuId_captu_idx" ON "SupplierPriceSnapshot"("supplierProductId", "externalSkuId", "capturedAt");

-- CreateIndex
CREATE INDEX "DailyMetric_shopId_day_idx" ON "DailyMetric"("shopId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMetric_shopId_day_key" ON "DailyMetric"("shopId", "day");

-- AddForeignKey
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAccount" ADD CONSTRAINT "StaffAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAccount" ADD CONSTRAINT "SupplierAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAccount" ADD CONSTRAINT "SupplierAccount_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierAccountId_fkey" FOREIGN KEY ("supplierAccountId") REFERENCES "SupplierAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierVariant" ADD CONSTRAINT "SupplierVariant_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierShippingOption" ADD CONSTRAINT "SupplierShippingOption_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedProduct" ADD CONSTRAINT "ImportedProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedProduct" ADD CONSTRAINT "ImportedProduct_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedProduct" ADD CONSTRAINT "ImportedProduct_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "PricingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedVariant" ADD CONSTRAINT "ImportedVariant_importedProductId_fkey" FOREIGN KEY ("importedProductId") REFERENCES "ImportedProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedVariant" ADD CONSTRAINT "ImportedVariant_supplierVariantId_fkey" FOREIGN KEY ("supplierVariantId") REFERENCES "SupplierVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantMapping" ADD CONSTRAINT "VariantMapping_productMappingId_fkey" FOREIGN KEY ("productMappingId") REFERENCES "ProductMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantMapping" ADD CONSTRAINT "VariantMapping_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantMapping" ADD CONSTRAINT "VariantMapping_supplierVariantId_fkey" FOREIGN KEY ("supplierVariantId") REFERENCES "SupplierVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRuleTier" ADD CONSTRAINT "PricingRuleTier_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "PricingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingPreference" ADD CONSTRAINT "ShippingPreference_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPolicy" ADD CONSTRAINT "InventoryPolicy_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierAccountId_fkey" FOREIGN KEY ("supplierAccountId") REFERENCES "SupplierAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_supplierVariantId_fkey" FOREIGN KEY ("supplierVariantId") REFERENCES "SupplierVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingNumber" ADD CONSTRAINT "TrackingNumber_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPriceSnapshot" ADD CONSTRAINT "SupplierPriceSnapshot_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMetric" ADD CONSTRAINT "DailyMetric_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

