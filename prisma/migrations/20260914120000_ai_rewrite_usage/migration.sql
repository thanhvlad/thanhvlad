-- A monthly counter of AI landing-page rewrites per account. The rewrite was
-- previously unmetered on every plan, including the free one, and each call is
-- real model spend. Nothing existing changes; the table starts empty, which
-- gives every account its full allowance for the current month.
CREATE TABLE IF NOT EXISTS "AiRewriteUsage" (
    "id" TEXT NOT NULL,
    "ownerKey" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRewriteUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AiRewriteUsage_ownerKey_period_key" ON "AiRewriteUsage"("ownerKey", "period");
