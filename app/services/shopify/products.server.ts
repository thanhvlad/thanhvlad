import { assertNoUserErrors, gql, type GraphqlClient, type UserError } from "./graphql.server";

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

  const data = await gql<{
    productSet: { product: RawProduct | null; userErrors: UserError[] };
  }>(client, PRODUCT_SET_MUTATION, {
    synchronous: true,
    input: {
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
  });

  assertNoUserErrors(data.productSet.userErrors, "productSet");
  if (!data.productSet.product) throw new Error("productSet returned no product");
  return normalizeProduct(data.productSet.product);
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
      }
    }
  }
`;

export async function fetchProduct(client: GraphqlClient, id: string) {
  const data = await gql<{ product: (RawProduct & { vendor: string | null }) | null }>(client, PRODUCT_QUERY, { id });
  if (!data.product) return null;
  return {
    ...normalizeProduct(data.product),
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

const INVENTORY_SET_QUANTITIES = `#graphql
  mutation DropshipInventorySet($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { reason }
      userErrors { field message }
    }
  }
`;

export async function setInventoryQuantities(
  client: GraphqlClient,
  locationId: string,
  quantities: Array<{ inventoryItemId: string; quantity: number }>,
) {
  if (quantities.length === 0) return;
  const data = await gql<{
    inventorySetQuantities: { userErrors: UserError[] };
  }>(client, INVENTORY_SET_QUANTITIES, {
    input: {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: quantities.map((q) => ({
        inventoryItemId: q.inventoryItemId,
        locationId,
        quantity: Math.max(0, q.quantity),
      })),
    },
  });
  assertNoUserErrors(data.inventorySetQuantities.userErrors, "inventorySetQuantities");
}

const PRODUCT_UPDATE_STATUS = `#graphql
  mutation DropshipProductStatus($input: ProductInput!) {
    productUpdate(input: $input) {
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
  const data = await gql<{ productUpdate: { userErrors: UserError[] } }>(client, PRODUCT_UPDATE_STATUS, {
    input: { id: productId, status },
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
    publications(first: 20) { nodes { id name } }
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
  const data = await gql<{ publications: { nodes: Array<{ id: string; name: string }> } }>(
    client,
    PUBLICATIONS_QUERY,
  );
  const targets = data.publications.nodes.filter((p) => /online store|headless|shop/i.test(p.name));
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
  variants: {
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

function normalizeProduct(raw: RawProduct): PushedProduct {
  return {
    id: raw.id,
    handle: raw.handle,
    title: raw.title,
    status: raw.status,
    featuredImage: raw.featuredMedia?.preview?.image?.url ?? null,
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
