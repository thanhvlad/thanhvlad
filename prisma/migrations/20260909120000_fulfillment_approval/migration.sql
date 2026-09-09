-- A Shopify fulfilment request is now priced and held for the merchant to
-- approve before anything is ordered upstream. Existing rows keep their status.
ALTER TYPE "FulfillmentRequestStatus" ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL' BEFORE 'ACCEPTED';

ALTER TABLE "FulfillmentRequest"
  ADD COLUMN IF NOT EXISTS "quote" JSONB,
  ADD COLUMN IF NOT EXISTS "quotedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "quoteError" TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedBy" TEXT;
