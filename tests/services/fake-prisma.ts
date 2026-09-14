/**
 * A small in-memory stand-in for the Prisma client, for service tests that
 * must not touch a database.
 *
 * It understands exactly the query shapes the privacy code uses - scalar and
 * JSON filters, OR/AND/NOT, to-many `none`/`some` relation filters, to-one
 * relation filters, composite unique keys, and relation includes - and throws
 * on anything else, so a query it cannot evaluate fails the test instead of
 * silently matching every row.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

interface Relation {
  model: string;
  many: boolean;
  /** Column on the child pointing at this row (to-many). */
  fk?: string;
  /** Column on this row pointing at the parent (to-one). */
  localKey?: string;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  order: {
    lineItems: { model: "orderLineItem", many: true, fk: "orderId" },
    purchaseOrders: { model: "purchaseOrder", many: true, fk: "orderId" },
    fulfillmentRequests: { model: "fulfillmentRequest", many: true, fk: "orderId" },
    shop: { model: "shop", many: false, localKey: "shopId" },
  },
  purchaseOrder: {
    trackings: { model: "trackingNumber", many: true, fk: "purchaseOrderId" },
    items: { model: "purchaseOrderItem", many: true, fk: "purchaseOrderId" },
    order: { model: "order", many: false, localKey: "orderId" },
  },
  productVariant: { product: { model: "product", many: false, localKey: "productId" } },
  webhookEvent: { shop: { model: "shop", many: false, localKey: "shopId" } },
};

const DEFAULTS: Record<string, () => Row> = {
  order: () => ({ stage: "PENDING", issues: [], shippingAddress: {}, note: null, customerName: null, customerEmail: null, phone: null, countryCode: null, canceledAt: null, riskLevel: null, placedAt: null }),
  orderLineItem: () => ({ isCanceled: false, isFulfilled: false, productVariantId: null, resolution: {} }),
  purchaseOrder: () => ({ raw: {}, errorMessage: null, supplierNote: null }),
  trackingNumber: () => ({ syncError: null }),
  fulfillmentRequest: () => ({ requestMessage: null, responseMessage: null, quote: null, quoteError: null }),
  activityLog: () => ({ meta: {}, entity: null, entityId: null, actor: "system", level: "info" }),
  notification: () => ({ meta: {}, body: null, link: null, readAt: null, archivedAt: null, emailedAt: null, severity: "info" }),
  jobRun: () => ({ payload: {}, result: {}, error: null }),
  webhookEvent: () => ({ payload: {}, processedAt: null, error: null, shopId: null }),
};

const OPERATORS = new Set(["equals", "in", "notIn", "not", "lt", "lte", "gt", "gte", "startsWith", "contains", "mode", "path", "array_contains"]);

function isPlainObject(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class FakePrisma {
  tables: Record<string, Row[]> = {};
  private seq = 0;

  constructor() {
    return new Proxy(this, {
      get: (target, prop: string) => {
        if (prop in target) return (target as any)[prop];
        return target.model(prop);
      },
    });
  }

  seed(model: string, rows: Row[]): Row[] {
    const table = this.table(model);
    const created = rows.map((row) => this.withDefaults(model, row));
    table.push(...created);
    return created;
  }

  rows(model: string): Row[] {
    return this.table(model);
  }

  async $transaction(arg: any) {
    if (typeof arg === "function") return arg(this);
    return Promise.all(arg);
  }

  async $executeRaw() {
    return 0;
  }

  async $disconnect() {}

  private table(model: string): Row[] {
    this.tables[model] ??= [];
    return this.tables[model];
  }

  private withDefaults(model: string, row: Row): Row {
    const now = new Date();
    return { id: `${model}_${++this.seq}`, createdAt: now, updatedAt: now, ...(DEFAULTS[model]?.() ?? {}), ...row };
  }

  private matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => this.matchKey(model, row, key, cond));
  }

  private matchKey(model: string, row: Row, key: string, cond: any): boolean {
    if (cond === undefined) return true;
    if (key === "AND") return (Array.isArray(cond) ? cond : [cond]).every((c) => this.matches(model, row, c));
    if (key === "OR") return (cond as Row[]).some((c) => this.matches(model, row, c));
    if (key === "NOT") return !(Array.isArray(cond) ? cond : [cond]).some((c) => this.matches(model, row, c));

    const relation = RELATIONS[model]?.[key];
    if (relation) {
      if (relation.many) {
        const children = this.table(relation.model).filter((child) => child[relation.fk!] === row.id);
        if ("none" in cond) return !children.some((child) => this.matches(relation.model, child, cond.none));
        if ("some" in cond) return children.some((child) => this.matches(relation.model, child, cond.some));
        if ("every" in cond) return children.every((child) => this.matches(relation.model, child, cond.every));
        throw new Error(`FakePrisma: unsupported relation filter on ${model}.${key}`);
      }
      const parent = this.table(relation.model).find((p) => p.id === row[relation.localKey!]);
      return Boolean(parent) && this.matches(relation.model, parent!, cond);
    }

    // Composite unique key: { shopId_shopifyOrderId: { shopId, shopifyOrderId } }.
    if (!(key in row) && key.includes("_") && isPlainObject(cond)) {
      return Object.entries(cond).every(([k, v]) => deepEqual(row[k], v));
    }

    const value = row[key];
    if (!isPlainObject(cond)) return comparable(value) === comparable(cond) || (cond === null && value === undefined);
    const unknown = Object.keys(cond).filter((k) => !OPERATORS.has(k));
    if (unknown.length > 0) throw new Error(`FakePrisma: unsupported filter ${model}.${key}: ${unknown.join(",")}`);

    const insensitive = cond.mode === "insensitive";
    const norm = (v: unknown) => (insensitive && typeof v === "string" ? v.toLowerCase() : comparable(v));
    let subject: unknown = value;
    if (cond.path) {
      for (const segment of cond.path as string[]) subject = isPlainObject(subject) ? subject[segment] : undefined;
    }
    if ("equals" in cond) {
      if (isPlainObject(cond.equals) || Array.isArray(cond.equals)) {
        if (!deepEqual(subject, cond.equals)) return false;
      } else if (norm(subject) !== norm(cond.equals)) return false;
    }
    if ("array_contains" in cond) {
      const needles = Array.isArray(cond.array_contains) ? cond.array_contains : [cond.array_contains];
      if (!Array.isArray(subject) || !needles.every((n: unknown) => (subject as unknown[]).some((s) => deepEqual(s, n)))) return false;
    }
    if ("in" in cond && !(cond.in as unknown[]).some((v) => norm(v) === norm(subject))) return false;
    if ("notIn" in cond && (cond.notIn as unknown[]).some((v) => norm(v) === norm(subject))) return false;
    if ("not" in cond) {
      if (cond.not === null) {
        if (subject === null || subject === undefined) return false;
      } else if (isPlainObject(cond.not)) {
        if (this.matchKey(model, row, key, cond.not)) return false;
      } else if (norm(subject) === norm(cond.not)) return false;
    }
    if ("lt" in cond && !(subject !== null && subject !== undefined && (comparable(subject) as number) < (comparable(cond.lt) as number))) return false;
    if ("lte" in cond && !(subject !== null && subject !== undefined && (comparable(subject) as number) <= (comparable(cond.lte) as number))) return false;
    if ("gt" in cond && !(subject !== null && subject !== undefined && (comparable(subject) as number) > (comparable(cond.gt) as number))) return false;
    if ("gte" in cond && !(subject !== null && subject !== undefined && (comparable(subject) as number) >= (comparable(cond.gte) as number))) return false;
    if ("startsWith" in cond && !(typeof subject === "string" && String(norm(subject)).startsWith(String(norm(cond.startsWith))))) return false;
    if ("contains" in cond && !(typeof subject === "string" && String(norm(subject)).includes(String(norm(cond.contains))))) return false;
    return true;
  }

  private shape(model: string, row: Row, args: Row | undefined): Row {
    const out: Row = structuredClone(row);
    const nested = { ...(args?.include ?? {}), ...(args?.select ?? {}) };
    for (const [key, spec] of Object.entries(nested)) {
      const relation = RELATIONS[model]?.[key];
      if (!relation || !spec) continue;
      const childArgs = isPlainObject(spec) ? spec : undefined;
      if (relation.many) {
        out[key] = this.table(relation.model)
          .filter((child) => child[relation.fk!] === row.id && this.matches(relation.model, child, childArgs?.where))
          .map((child) => this.shape(relation.model, child, childArgs));
      } else {
        const parent = this.table(relation.model).find((p) => p.id === row[relation.localKey!]);
        out[key] = parent ? this.shape(relation.model, parent, childArgs) : null;
      }
    }
    return out;
  }

  private find(model: string, args: Row = {}): Row[] {
    let rows = this.table(model).filter((row) => this.matches(model, row, args.where));
    const order = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
    if (order) {
      const [field, direction] = Object.entries(order)[0] as [string, string];
      rows = [...rows].sort((a, b) => {
        const x = comparable(a[field]) as any;
        const y = comparable(b[field]) as any;
        const cmp = x < y ? -1 : x > y ? 1 : 0;
        return direction === "desc" ? -cmp : cmp;
      });
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((row) => this.shape(model, row, args));
  }

  private apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      row[key] = value instanceof Date ? value : structuredClone(value);
    }
    row.updatedAt = new Date();
  }

  private model(name: string) {
    return {
      findMany: async (args?: Row) => this.find(name, args),
      findFirst: async (args?: Row) => this.find(name, args)[0] ?? null,
      findUnique: async (args?: Row) => this.find(name, args)[0] ?? null,
      findFirstOrThrow: async (args?: Row) => {
        const row = this.find(name, args)[0];
        if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
        return row;
      },
      count: async (args?: Row) => this.table(name).filter((row) => this.matches(name, row, args?.where)).length,
      create: async (args: Row) => {
        const row = this.withDefaults(name, structuredClone(args.data));
        this.table(name).push(row);
        return this.shape(name, row, args);
      },
      update: async (args: Row) => {
        const row = this.table(name).find((r) => this.matches(name, r, args.where));
        if (!row) throw Object.assign(new Error(`${name} not found`), { code: "P2025" });
        this.apply(row, args.data);
        return this.shape(name, row, args);
      },
      updateMany: async (args: Row) => {
        const rows = this.table(name).filter((r) => this.matches(name, r, args.where));
        for (const row of rows) this.apply(row, args.data);
        return { count: rows.length };
      },
      upsert: async (args: Row) => {
        const row = this.table(name).find((r) => this.matches(name, r, args.where));
        if (row) {
          this.apply(row, args.update);
          return this.shape(name, row, args);
        }
        const created = this.withDefaults(name, structuredClone(args.create));
        this.table(name).push(created);
        return this.shape(name, created, args);
      },
      delete: async (args: Row) => {
        const table = this.table(name);
        const index = table.findIndex((r) => this.matches(name, r, args.where));
        if (index < 0) throw Object.assign(new Error(`${name} not found`), { code: "P2025" });
        return table.splice(index, 1)[0];
      },
      deleteMany: async (args?: Row) => {
        const table = this.table(name);
        const keep = table.filter((r) => !this.matches(name, r, args?.where));
        const count = table.length - keep.length;
        this.tables[name] = keep;
        return { count };
      },
    };
  }
}
