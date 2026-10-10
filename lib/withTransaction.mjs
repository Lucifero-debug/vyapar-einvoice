import mongoose from "mongoose";
import { connect } from "./mongodb";

/**
 * Run a unit of work inside a MongoDB transaction.
 *
 * Every write in these routes touches several collections — an invoice, the
 * party's balance, the ledger, the stock ledger. Without a transaction a
 * failure part-way leaves the books disagreeing with themselves, and the only
 * way back is one of the rebuild scripts.
 *
 *     const result = await withTransaction(async (session) => {
 *       const [invoice] = await Invoice.create([body], { session });
 *       await Ledger.insertMany(rows, { session });
 *       return invoice;
 *     });
 *
 * EVERY query inside the callback must be passed `{ session }`. One that isn't
 * runs outside the transaction: it won't roll back, and it can't see the
 * uncommitted writes around it. That is the single easy mistake here.
 *
 * Throwing from the callback aborts and rolls back. Throw `AbortTransaction`
 * to reject the work deliberately and still control the HTTP response.
 *
 * REQUIRES a replica set or sharded cluster — transactions do not exist on a
 * standalone mongod. Atlas is always a replica set. There is deliberately no
 * silent non-transactional fallback: quietly degrading would reintroduce
 * exactly the partial-write corruption this exists to prevent.
 */
export async function withTransaction(fn) {
  await connect();

  const session = await mongoose.startSession();
  try {
    let result;
    // withTransaction retries the callback on transient/commit errors, so the
    // body must be safe to run more than once. These callbacks are: every
    // write is scoped to the session and rolled back before a retry.
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Abort the transaction and carry the HTTP response to send instead.
 *
 * The existing routes return a mix of shapes and status codes; this preserves
 * whatever each one already sent rather than standardising them here.
 */
export class AbortTransaction extends Error {
  constructor(payload, status = 200) {
    super(payload?.error || payload?.message || "Transaction aborted");
    this.name = "AbortTransaction";
    this.payload = payload;
    this.status = status;
  }
}

/** True when the cluster cannot do transactions at all. */
export function isUnsupported(err) {
  return (
    err?.code === 20 ||
    /Transaction numbers are only allowed on a replica set|transactions are not supported/i.test(
      err?.message || ""
    )
  );
}
