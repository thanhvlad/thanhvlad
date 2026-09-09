-- AlterEnum
ALTER TYPE "OrderStage" ADD VALUE 'IGNORED';

-- AlterTable
ALTER TABLE "ImportedProduct" ADD COLUMN     "shopifyProductId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "fxRate" DECIMAL(18,8),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "shopCurrency" TEXT,
ADD COLUMN     "shopItemsCost" DECIMAL(18,4),
ADD COLUMN     "shopShippingCost" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "carrierCode" TEXT,
ADD COLUMN     "carrierName" TEXT,
ADD COLUMN     "estimatedDeliveryDays" INTEGER,
ADD COLUMN     "shipFromCountry" TEXT,
ADD COLUMN     "shippingCost" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "TrackingNumber" ADD COLUMN     "fulfilledQuantities" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orderId_idempotencyKey_key" ON "PurchaseOrder"("orderId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_orderLineItemId_idx" ON "PurchaseOrderItem"("orderLineItemId");

-- DropIndex
DROP INDEX "SupplierShippingOption_supplierProductId_shipFromCountry_sh_key";

-- AlterTable
ALTER TABLE "SupplierShippingOption" ADD COLUMN     "externalSkuId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "SupplierShippingOption_supplierProductId_shipFromCountry_sh_key" ON "SupplierShippingOption"("supplierProductId", "shipFromCountry", "shipToCountry", "carrierCode", "quantity", "externalSkuId");

