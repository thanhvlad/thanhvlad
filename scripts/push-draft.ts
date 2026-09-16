/**
 * Push one import-list product to Shopify as a DRAFT.
 *
 * For proving the push path against a live store without putting anything in
 * front of its customers. The shop's own "default status" setting is not
 * changed: the override exists only in this process, so a failure halfway
 * through cannot leave the store pushing every later product as a draft.
 *
 *   node --env-file-if-exists=.env --import tsx/esm scripts/push-draft.ts <shop-domain> <importedProductId>
 */
import { bootJobs, shutdownQueue } from "../app/services/jobs/index.server";
import { pushImportedProduct } from "../app/services/import.server";
import { getShopByDomain } from "../app/services/shop.server";
import { offlineClient } from "../app/services/shopify/graphql.server";

const [domain, importedProductId] = process.argv.slice(2);
if (!domain || !importedProductId) {
  console.error("usage: push-draft.ts <shop-domain> <importedProductId>");
  process.exit(1);
}

bootJobs({ worker: false });

const shop = await getShopByDomain(domain);
if (!shop) {
  console.error(`No shop ${domain} in this database.`);
  process.exit(1);
}

const draftOnly = {
  ...shop,
  parsedSettings: {
    ...shop.parsedSettings,
    // publishOnPush is off as well: publishing only applies to ACTIVE products,
    // but saying so here keeps the intent readable at the call site.
    products: { ...shop.parsedSettings.products, defaultStatus: "DRAFT" as const, publishOnPush: false },
  },
};

const client = await offlineClient(shop.domain);
const result = await pushImportedProduct(draftOnly, client, importedProductId, "ops:push-draft");
console.info(JSON.stringify(result, null, 2));

await shutdownQueue();
process.exit(result.ok ? 0 : 2);
