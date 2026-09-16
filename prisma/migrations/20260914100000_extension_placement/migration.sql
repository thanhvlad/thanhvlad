-- Supplier orders the app cannot place itself (no AliExpress API connection)
-- are now created as AWAITING_PLACEMENT and placed from the merchant's browser
-- through the Chrome extension. Before this, such orders were "placed" through
-- the mock supplier: a MOCK- order id, a fake payment link and invented
-- tracking, with nothing ever reaching AliExpress.
--
-- ADD VALUE IF NOT EXISTS is idempotent, and on PostgreSQL 12+ it may run inside
-- the migration transaction as long as the new value is not used in the same
-- transaction, which this migration does not do. Existing rows keep their status.
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PLACEMENT' BEFORE 'PLACED';
