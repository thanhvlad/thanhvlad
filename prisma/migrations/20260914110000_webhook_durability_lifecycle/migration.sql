-- Webhook durability and the install/uninstall/billing lifecycle.
--
-- Every statement is additive and idempotent, so a deploy that retries the
-- migration after a partial run does not fail on objects it already created.

-- WebhookEvent: remember the store by domain, the event id shared by duplicate
-- subscriptions, the trigger time, and the lease/attempt bookkeeping the
-- recovery sweep needs.
ALTER TABLE "WebhookEvent"
  ADD COLUMN IF NOT EXISTS "shopDomain" TEXT,
  ADD COLUMN IF NOT EXISTS "eventId" TEXT,
  ADD COLUMN IF NOT EXISTS "triggeredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);

-- Existing rows get their domain from the shop they already point at.
UPDATE "WebhookEvent" AS w
SET "shopDomain" = s."domain"
FROM "Shop" AS s
WHERE w."shopId" = s."id" AND w."shopDomain" IS NULL;

-- Existing rows have no event id, and PostgreSQL treats NULLs as distinct, so
-- this cannot fail on historical data.
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_shopDomain_topic_eventId_key"
  ON "WebhookEvent"("shopDomain", "topic", "eventId");

CREATE INDEX IF NOT EXISTS "WebhookEvent_processedAt_createdAt_idx"
  ON "WebhookEvent"("processedAt", "createdAt");

-- Shop: install generation, webhook verification and the one-time trial.
ALTER TABLE "Shop"
  ADD COLUMN IF NOT EXISTS "lastAuthAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "webhooksCheckedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trialStartedAt" TIMESTAMP(3);

-- A store that already had a paid subscription with a trial has used its trial.
UPDATE "Shop" AS s
SET "trialStartedAt" = COALESCE(a."trialEndsAt" - INTERVAL '14 days', a."planChangedAt", a."updatedAt")
FROM "Account" AS a
WHERE a."billingShopId" = s."id"
  AND a."subscriptionId" IS NOT NULL
  AND s."trialStartedAt" IS NULL;

-- Account: single-use invite codes replace sharing the raw account id.
ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "joinCode" TEXT,
  ADD COLUMN IF NOT EXISTS "joinCodeExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Account_joinCode_key" ON "Account"("joinCode");
