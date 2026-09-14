import { AppError, errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { assertNoUserErrors, gql, operationIdempotencyKey, type GraphqlClient, type UserError } from "./graphql.server";

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface PushVariantInput {
  optionValues: string[];
  sku?: string | null;
  price: string;
  compareAtPrice?: string | null;
  cost?: string | null;
  weightGrams?: number | null;
  inventoryQuantity: number;
  imageUrl?: string | null;
  barcode?: string | null;
}

export interface PushProductInput {
  /**
   * Shopify product id to write into, when one already exists.
   *
   * `productSet` upserts on this, which is what makes a retry after a failed
   * push safe: without it the second attempt creates a second listing of the
   * same item in the merchant's store.
   */
  id?: string | null;
  title: string;
  descriptionHtml: string;
  vendor?: string | null;
  productType?: string | null;
  tags: string[];
  handle?: string | null;
  status: "ACTIVE" | "DRAFT";
  optionNames: string[];
  images: string[];
  variants: PushVariantInput[];
  locationId: string | null;
  trackInventory: boolean;
  weightUnit: "GRAMS" | "KILOGRAMS" | "OUNCES" | "POUNDS";
  collectionIds?: string[];
}

export interface PushedProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  featuredImage: string | null;
  /**
   * Media Shopify could not ingest, as far as it knows by the time productSet
   * returns. Supplier CDNs refuse hotlinking often enough that a push can
   * "succeed" with no pictures at all; this is where that shows.
   */
  failedMedia: Array<{ id: string; alt: string | null; message: string }>;
  /** Media still being fetched when the push returned; its outcome is not known yet. */
  processingMediaCount: number;
  /**
   * True when Shopify created or updated the product but the variants beyond
   * the first page could not be read back. `variants` then lists only the
   * first 250. The product exists all the same, and its id must be kept: a
   * push that threw here lost the id, and the retry created a second listing.
   * A later push (an upsert on the saved id) or fetchProduct reads them all.
   */
  variantsIncomplete: boolean;
  variants: Array<{
    id: string;
    title: string;
    sku: string | null;
    price: string;
    compareAtPrice: string | null;
    inventoryItemId: string;
    optionValues: string[];
    position: number;
  }>;
}

const PRODUCT_SET_MUTATION = `#graphql
  mutation DropshipProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        handle
        title
        status
        featuredMedia { preview { image { url } } }
        media(first: 50) {
          nodes { id alt status mediaErrors { code details message } }
        }
        variants(first: 250) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            position
            inventoryItem { id }
            selectedOptions { name value }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      userErrors { field message code }
    }
  }
`;

const DEFAULT_OPTION = "Title";
const DEFAULT_VALUE = "Default Title";

/**
 * Create a product with all variants, images and inventory in one call using
 * `productSet`. Variants are matched to images by URL so each colour swatch
 * gets its own picture, the way suppliers present them.
 *
 * Synchronous mode is kept for every size: Shopify documents both modes as a
 * choice rather than a threshold, and the push already runs in a job. What a
 * large product did break was the read-back: the payload lists 250 variants,
 * so the rest are paged in afterwards (see readRemainingVariants). Before that,
 * variant 251 onwards never got a supplier mapping and could not be ordered.
 */
export async function createProduct(
  client: GraphqlClient,
  input: PushProductInput,
): Promise<PushedProduct> {
  const optionNames = input.optionNames.length ? input.optionNames : [DEFAULT_OPTION];

  const files = uniq([...input.images, ...input.variants.map((v) => v.imageUrl ?? "")].filter(Boolean)).map(
    (url) => ({ originalSource: url, contentType: "IMAGE", alt: input.title }),
  );

  const productOptions = optionNames.map((name, index) => ({
    name,
    position: index + 1,
    values: uniq(
      input.variants.map((v) => v.optionValues[index] ?? (name === DEFAULT_OPTION ? DEFAULT_VALUE : "")),
    )
      .filter(Boolean)
      .map((value) => ({ name: value })),
  }));

  const variants = input.variants.map((variant) => ({
    optionValues: optionNames.map((name, index) => ({
      optionName: name,
      name: variant.optionValues[index] ?? (name === DEFAULT_OPTION ? DEFAULT_VALUE : ""),
    })),
    sku: variant.sku ?? undefined,
    barcode: variant.barcode ?? undefined,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice ?? undefined,
    inventoryPolicy: input.trackInventory ? "DENY" : "CONTINUE",
    inventoryItem: {
      tracked: input.trackInventory,
      cost: variant.cost ?? undefined,
      ...(variant.weightGrams
        ? { measurement: { weight: { value: toWeight(variant.weightGrams, input.weightUnit), unit: input.weightUnit } } }
        : {}),
    },
    ...(input.locationId
      ? {
          inventoryQuantities: [
            { locationId: input.locationId, name: "available", quantity: variant.inventoryQuantity },
          ],
        }
      : {}),
    ...(variant.imageUrl ? { file: { originalSource: variant.imageUrl, contentType: "IMAGE" } } : {}),
  }));

  const variables = {
    synchronous: true,
    input: {
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      descriptionHtml: input.descriptionHtml,
      vendor: input.vendor || undefined,
      productType: input.productType || undefined,
      tags: input.tags,
      handle: input.handle || undefined,
      status: input.status,
      productOptions,
      files,
      variants,
      ...(input.collectionIds?.length ? { collections: input.collectionIds } : {}),
    },
  };
  const data = await gql<{
    productSet: { product: RawProduct | null; userErrors: UserError[] };
  }>(client, PRODUCT_SET_MUTATION, variables, {
    // With an id productSet is an upsert, so a replay after a lost response
    // writes the same state again. Without one it creates, and a replay would
    // put a second copy of the listing in the merchant's store.
    replaySafe: Boolean(input.id),
  });

  assertNoUserErrors(data.productSet.userErrors, "productSet");
  const product = data.productSet.product;
  if (!product) throw new Error("productSet returned no product");
  let variantsIncomplete = false;
  if (product.variants.pageInfo?.hasNextPage) {
    try {
      product.variants.nodes.push(...(await readRemainingVariants(client, product.id, product.variants.pageInfo.endCursor)));
    } catch (error) {
      // From here on the product exists in the merchant's store. Throwing would
      // drop its id with the error, and the next push would create a copy.
      variantsIncomplete = true;
      logger.warn("Pushed product, but could not read back all of its variants", {
        productId: product.id,
        readVariants: product.variants.nodes.length,
        error: errorMessage(error),
      });
    }
  }
  return { ...normalizeProduct(product), variantsIncomplete };
}

const PRODUCT_VARIANTS_PAGE_QUERY = `#graphql
  query DropshipProductVariantsPage($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          position
          inventoryQuantity
          inventoryItem { id unitCost { amount } }
          selectedOptions { name value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/** Every variant after `after`, for products larger than one 250-variant page. */
async function readRemainingVariants(client: GraphqlClient, productId: string, after: string | null) {
  const nodes: RawProduct["variants"]["nodes"] = [];
  let cursor = after;
  while (cursor) {
    const data = await gql<{ product: { variants: RawProduct["variants"] } | null }>(client, PRODUCT_VARIANTS_PAGE_QUERY, {
      id: productId,
      after: cursor,
    });
    // A product that vanishes between pages is not "no more variants". Stopping
    // here returned a partial list, and syncProductFromShopify prunes every
    // local variant missing from that list, mappings included.
    if (!data.product) {
      throw new AppError("SHOPIFY_PRODUCT_VANISHED", `Product ${productId} disappeared while its variants were being read`, {
        retryable: true,
        details: { productId, read: nodes.length },
      });
    }
    nodes.push(...data.product.variants.nodes);
    cursor = data.product.variants.pageInfo?.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
  }
  return nodes;
}

const PRODUCT_MEDIA_QUERY = `#graphql
  query DropshipProductMedia($id: ID!) {
    product(id: $id) {
      media(first: 100) {
        nodes { id alt status mediaErrors { code details message } }
      }
    }
  }
`;

/**
 * The product's media processing state, for checking a push some time after it
 * returned: Shopify fetches `originalSource` URLs in the background, so most
 * failures only appear here seconds to minutes later.
 */
export async function fetchProductMediaStatus(client: GraphqlClient, productId: string) {
  const data = await gql<{ product: { media: { nodes: RawMedia[] } } | null }>(client, PRODUCT_MEDIA_QUERY, { id: productId });
  if (!data.product) return null;
  return summariseMedia(data.product.media.nodes);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const PRODUCT_QUERY = `#graphql
  query DropshipProduct($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      status
      vendor
      featuredMedia { preview { image { url } } }
      variants(first: 250) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          position
          inventoryQuantity
          inventoryItem { id unitCost { amount } }
          selectedOptions { name value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export async function fetchProduct(client: GraphqlClient, id: string) {
  const data = await gql<{ product: (RawProduct & { vendor: string | null }) | null }>(client, PRODUCT_QUERY, { id });
  if (!data.product) return null;
  if (data.product.variants.pageInfo?.hasNextPage) {
    data.product.variants.nodes.push(
      ...(await readRemainingVariants(client, data.product.id, data.product.variants.pageInfo.endCursor)),
    );
  }
  const { variantsIncomplete: _complete, ...product } = normalizeProduct(data.product);
  return {
    ...product,
    vendor: data.product.vendor,
    variants: data.product.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      inventoryItemId: v.inventoryItem.id,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      cost: v.inventoryItem.unitCost?.amount ?? null,
      optionValues: v.selectedOptions.map((o) => o.value),
      position: v.position,
    })),
  };
}

const PRODUCTS_SEARCH_QUERY = `#graphql
  query DropshipProductsSearch($query: String, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        status
        vendor
        featuredMedia { preview { image { url } } }
        variantsCount { count }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function searchProducts(
  client: GraphqlClient,
  options: { query?: string; first?: number; after?: string | null },
) {
  const data = await gql<{
    products: {
      nodes: Array<{
        id: string;
        title: string;
        handle: string;
        status: string;
        vendor: string | null;
        featuredMedia: { preview: { image: { url: string } | null } | null } | null;
        variantsCount: { count: number } | null;
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(client, PRODUCTS_SEARCH_QUERY, {
    query: options.query ?? null,
    first: options.first ?? 25,
    after: options.after ?? null,
  });
  return {
    nodes: data.products.nodes.map((p) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      status: p.status,
      vendor: p.vendor,
      featuredImage: p.featuredMedia?.preview?.image?.url ?? null,
      variantsCount: p.variantsCount?.count ?? 0,
    })),
    pageInfo: data.products.pageInfo,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const VARIANTS_BULK_UPDATE = `#graphql
  mutation DropshipVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message }
    }
  }
`;

export interface VariantPriceUpdate {
  id: string;
  price?: string;
  compareAtPrice?: string | null;
  cost?: string | null;
}

export async function updateVariantPrices(
  client: GraphqlClient,
  productId: string,
  updates: VariantPriceUpdate[],
) {
  if (updates.length === 0) return [];
  const data = await gql<{
    productVariantsBulkUpdate: { productVariants: Array<{ id: string }>; userErrors: UserError[] };
  }>(client, VARIANTS_BULK_UPDATE, {
    productId,
    variants: updates.map((u) => ({
      id: u.id,
      ...(u.price !== undefined ? { price: u.price } : {}),
      ...(u.compareAtPrice !== undefined ? { compareAtPrice: u.compareAtPrice } : {}),
      ...(u.cost !== undefined && u.cost !== null ? { inventoryItem: { cost: u.cost } } : {}),
    })),
  });
  assertNoUserErrors(data.productVariantsBulkUpdate.userErrors, "productVariantsBulkUpdate");
  return data.productVariantsBulkUpdate.productVariants;
}

// The @idempotent key is REQUIRED on this mutation from Admin API 2026-04
// onwards, and this app pins 2026-07. Without it every call is rejected, which
// silently broke the whole hourly inventory sync. How the key is chosen is
// explained on operationIdempotencyKey.

const INVENTORY_SET_QUANTITIES = `#graphql
  mutation DropshipInventorySet($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { reason }
      userErrors { field message code }
    }
  }
`;

export async function setInventoryQuantities(
  client: GraphqlClient,
  locationId: string,
  quantities: Array<{ inventoryItemId: string; quantity: number }>,
  options: { operationId?: string | null } = {},
) {
  if (quantities.length === 0) return;
  const data = await gql<{
    inventorySetQuantities: { userErrors: UserError[] };
  }>(client, INVENTORY_SET_QUANTITIES, {
    // No `ignoreCompareQuantity`: it is not a field on InventorySetQuantitiesInput
    // (verified against the 2026-07 Admin schema), and an unknown key in the
    // variables is rejected by the server as a top-level error — every inventory
    // sync failed on it.
    input: {
      name: "available",
      reason: "correction",
      quantities: quantities.map((q) => ({
        inventoryItemId: q.inventoryItemId,
        locationId,
        quantity: Math.max(0, q.quantity),
        // Mandatory on 2026-07: changeFromQuantity must be sent explicitly, even
        // as null, "or the mutation returns an error". The schema types it as a
        // nullable Int, so a schema validator accepts an input without it and
        // only the server refuses. Null opts out of compare-and-swap, which
        // Shopify reserves for a caller that is the source of truth. This sync
        // is: it mirrors the supplier's stock. The only "expected" quantity it
        // could send is the local mirror, which never sees storefront sales and
        // would fail every write as CHANGE_FROM_QUANTITY_STALE.
        changeFromQuantity: null,
      })),
    },
    key: operationIdempotencyKey("inventorySetQuantities", options.operationId, locationId, quantities),
  });
  assertNoUserErrors(data.inventorySetQuantities.userErrors, "inventorySetQuantities");
}

const PRODUCT_UPDATE_STATUS = `#graphql
  mutation DropshipProductStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id status }
      userErrors { field message }
    }
  }
`;

export async function setProductStatus(
  client: GraphqlClient,
  productId: string,
  status: "ACTIVE" | "DRAFT" | "ARCHIVED",
) {
  // `input` on productUpdate is deprecated in favour of `product`.
  const data = await gql<{ productUpdate: { userErrors: UserError[] } }>(client, PRODUCT_UPDATE_STATUS, {
    product: { id: productId, status },
  });
  assertNoUserErrors(data.productUpdate.userErrors, "productUpdate");
}

const PRODUCT_DELETE = `#graphql
  mutation DropshipProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

export async function deleteProduct(client: GraphqlClient, productId: string) {
  const data = await gql<{ productDelete: { deletedProductId: string | null; userErrors: UserError[] } }>(
    client,
    PRODUCT_DELETE,
    { input: { id: productId } },
  );
  assertNoUserErrors(data.productDelete.userErrors, "productDelete");
  return data.productDelete.deletedProductId;
}

const PUBLICATIONS_QUERY = `#graphql
  query DropshipPublications {
    publications(first: 20) { nodes { id catalog { title } } }
  }
`;

const PUBLISH_MUTATION = `#graphql
  mutation DropshipPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

/** Publish to every sales channel that looks like an online storefront. */
export async function publishProduct(client: GraphqlClient, productId: string) {
  // Publication.name is deprecated in favour of the catalog's title.
  const data = await gql<{ publications: { nodes: Array<{ id: string; catalog: { title: string } | null }> } }>(
    client,
    PUBLICATIONS_QUERY,
  );
  const targets = data.publications.nodes.filter((p) => /online store|headless|shop/i.test(p.catalog?.title ?? ""));
  if (targets.length === 0) return;
  const result = await gql<{ publishablePublish: { userErrors: UserError[] } }>(client, PUBLISH_MUTATION, {
    id: productId,
    input: targets.map((p) => ({ publicationId: p.id })),
  });
  assertNoUserErrors(result.publishablePublish.userErrors, "publishablePublish");
}

const COLLECTIONS_QUERY = `#graphql
  query DropshipCollections($query: String) {
    collections(first: 50, query: $query) { nodes { id title handle } }
  }
`;

export async function listCollections(client: GraphqlClient, query?: string) {
  const data = await gql<{ collections: { nodes: Array<{ id: string; title: string; handle: string }> } }>(
    client,
    COLLECTIONS_QUERY,
    { query: query ?? null },
  );
  return data.collections.nodes;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RawProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  media?: { nodes: RawMedia[] } | null;
  variants: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null;
    nodes: Array<{
      id: string;
      title: string;
      sku: string | null;
      price: string;
      compareAtPrice: string | null;
      position: number;
      inventoryQuantity?: number | null;
      inventoryItem: { id: string; unitCost?: { amount: string } | null };
      selectedOptions: Array<{ name: string; value: string }>;
    }>;
  };
}

interface RawMedia {
  id: string;
  alt: string | null;
  status: string;
  mediaErrors?: Array<{ code: string; details: string | null; message: string }> | null;
}

export function summariseMedia(nodes: RawMedia[]) {
  const failedMedia = nodes
    .filter((m) => m.status === "FAILED")
    .map((m) => ({
      id: m.id,
      alt: m.alt,
      message:
        (m.mediaErrors ?? [])
          .map((e) => e.details || e.message)
          .filter(Boolean)
          .join("; ") || "Shopify could not process this image.",
    }));
  const processingMediaCount = nodes.filter((m) => m.status === "PROCESSING" || m.status === "UPLOADED").length;
  return { failedMedia, processingMediaCount };
}

function normalizeProduct(raw: RawProduct): PushedProduct {
  // Complete unless createProduct says otherwise: everywhere else a failed page
  // read throws instead of returning what it had so far.
  return {
    id: raw.id,
    handle: raw.handle,
    title: raw.title,
    status: raw.status,
    featuredImage: raw.featuredMedia?.preview?.image?.url ?? null,
    ...summariseMedia(raw.media?.nodes ?? []),
    variantsIncomplete: false,
    variants: raw.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      inventoryItemId: v.inventoryItem.id,
      optionValues: v.selectedOptions.map((o) => o.value),
      position: v.position,
    })),
  };
}

function toWeight(grams: number, unit: PushProductInput["weightUnit"]): number {
  switch (unit) {
    case "KILOGRAMS":
      return Number((grams / 1000).toFixed(3));
    case "OUNCES":
      return Number((grams / 28.3495).toFixed(2));
    case "POUNDS":
      return Number((grams / 453.592).toFixed(3));
    case "GRAMS":
    default:
      return grams;
  }
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}
