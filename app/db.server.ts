import { PrismaClient, type Prisma } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

// Vite re-evaluates server modules on every HMR update in development; keeping
// the client on `globalThis` prevents a new connection pool per reload.
const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Prisma's 5-second default is too tight for the interactive transactions
    // here: placing a supplier order and evaluating an order both take an
    // advisory lock and then write several rows, and a P2028 mid-way leaves the
    // store and the local mirror out of step.
    transactionOptions: { timeout: 30_000, maxWait: 10_000 },
  });

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
}

export default prisma;
export { prisma };

/** Writes per transaction chunk. */
const CHUNK_SIZE = 50;

/**
 * Run many writes as a series of bounded transactions.
 *
 * `prisma.$transaction(array)` runs its operations serially inside one
 * BEGIN/COMMIT, so a few hundred per-row updates — a 250-variant product being
 * repriced, a large order's line items — can outrun the transaction timeout and
 * abort with P2028. The Shopify-side write has usually already succeeded by
 * then, so the rollback leaves the store and the local mirror divergent with
 * nothing to repair it.
 *
 * Chunking trades all-or-nothing for completion. That is the right trade at
 * these call sites: they mirror state already written elsewhere, so a partial
 * mirror is repaired by the next sync, while a total rollback is not repaired
 * by anything.
 */
export async function chunkedTransaction<T>(
  operations: Array<Prisma.PrismaPromise<T>>,
  options: { chunkSize?: number } = {},
): Promise<void> {
  const size = Math.max(1, options.chunkSize ?? CHUNK_SIZE);
  for (let i = 0; i < operations.length; i += size) {
    await prisma.$transaction(operations.slice(i, i + size));
  }
}
