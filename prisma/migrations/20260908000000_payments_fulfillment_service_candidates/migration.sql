-- CreateEnum
CREATE TYPE "MappingSource" AS ENUM ('MANUAL', 'AUTO', 'AI');

-- CreateEnum
CREATE TYPE "FulfillmentRequestStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'CANCELLATION_REQUESTED', 'CANCELLED', 'CLOSED');

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "paymentDueAt" TIMESTAMP(3),
ADD COLUMN     "paymentMarkedAt" TIMESTAMP(3),
ADD COLUMN     "paymentReminderAt" TIMESTAMP(3),
ADD COLUMN     "paymentUrl" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "externalSkuAttr" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "fulfillmentLocationId" TEXT,
ADD COLUMN     "fulfillmentServiceId" TEXT,
ADD COLUMN     "fulfillmentServiceRegisteredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VariantMapping" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "source" "MappingSource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "FulfillmentRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyFulfillmentOrderId" TEXT NOT NULL,
    "status" "FulfillmentRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "requestMessage" TEXT,
    "responseMessage" TEXT,
    "lineItems" JSONB NOT NULL DEFAULT '[]',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "FulfillmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCandidate" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "itemCost" DECIMAL(18,4) NOT NULL,
    "shippingCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "landedCost" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "deliveryDays" INTEGER,
    "carrierName" TEXT,
    "rating" DOUBLE PRECISION,
    "orderCount" INTEGER,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scoreBreakdown" JSONB NOT NULL DEFAULT '{}',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "dismissedAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FulfillmentRequest_status_idx" ON "FulfillmentRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentRequest_orderId_shopifyFulfillmentOrderId_key" ON "FulfillmentRequest"("orderId", "shopifyFulfillmentOrderId");

-- CreateIndex
CREATE INDEX "SupplierCandidate_productId_score_idx" ON "SupplierCandidate"("productId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCandidate_productId_supplierProductId_key" ON "SupplierCandidate"("productId", "supplierProductId");

-- AddForeignKey
ALTER TABLE "FulfillmentRequest" ADD CONSTRAINT "FulfillmentRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCandidate" ADD CONSTRAINT "SupplierCandidate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCandidate" ADD CONSTRAINT "SupplierCandidate_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "fulfillmentAssigned" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SupplierAccount" ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "needsReauth" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "storeRegisteredAt" TIMESTAMP(3);

