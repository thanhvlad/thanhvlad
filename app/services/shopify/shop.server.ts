import { gql, type GraphqlClient } from "./graphql.server";

const SHOP_QUERY = `#graphql
  query DropshipShopInfo {
    shop {
      name
      email
      myshopifyDomain
      currencyCode
      ianaTimezone
      shopAddress { countryCodeV2 }
      currencyFormats { moneyFormat }
      plan { partnerDevelopment shopifyPlus }
    }
    locations(first: 1, query: "active:true") {
      nodes { id name }
    }
  }
`;

export interface ShopInfo {
  name: string;
  email: string | null;
  currencyCode: string;
  ianaTimezone: string;
  countryCode: string | null;
  moneyFormat: string | null;
  primaryLocationId: string | null;
  isDevelopmentStore: boolean;
}

export async function fetchShopInfo(client: GraphqlClient): Promise<ShopInfo> {
  const data = await gql<{
    shop: {
      name: string;
      email: string | null;
      currencyCode: string;
      ianaTimezone: string;
      shopAddress: { countryCodeV2: string | null } | null;
      currencyFormats: { moneyFormat: string } | null;
      plan: { partnerDevelopment: boolean } | null;
    };
    locations: { nodes: Array<{ id: string; name: string }> };
  }>(client, SHOP_QUERY);

  return {
    name: data.shop.name,
    email: data.shop.email,
    currencyCode: data.shop.currencyCode,
    ianaTimezone: data.shop.ianaTimezone,
    countryCode: data.shop.shopAddress?.countryCodeV2 ?? null,
    moneyFormat: data.shop.currencyFormats?.moneyFormat ?? null,
    primaryLocationId: data.locations.nodes[0]?.id ?? null,
    isDevelopmentStore: data.shop.plan?.partnerDevelopment ?? false,
  };
}

const LOCATIONS_QUERY = `#graphql
  query DropshipLocations {
    locations(first: 50) {
      nodes { id name isActive fulfillsOnlineOrders address { countryCode } }
    }
  }
`;

export async function fetchLocations(client: GraphqlClient) {
  const data = await gql<{
    locations: {
      nodes: Array<{
        id: string;
        name: string;
        isActive: boolean;
        fulfillsOnlineOrders: boolean;
        address: { countryCode: string | null } | null;
      }>;
    };
  }>(client, LOCATIONS_QUERY);
  return data.locations.nodes;
}
