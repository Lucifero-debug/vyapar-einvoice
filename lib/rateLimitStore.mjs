/**
 * The rate-limit counter, kept in MongoDB. The rules are lib/rateLimit.mjs.
 *
 * One atomic `$inc` with upsert per attempt, so two requests arriving at once
 * both count -- there is no read-then-write for them to race through.
 */

import RateLimit from "../models/rateLimitModel";
import { verdict, windowKey } from "./rateLimit.mjs";

/**
 * Count one attempt for `id` in `bucket` and say whether it may go ahead.
 *
 * The attempt is counted even when it is refused: a caller who keeps knocking
 * stays locked out until the window ends.
 */
export async function hitRateLimit(bucket, id, now = Date.now()) {
  const { key, resetAt } = windowKey(bucket, id, now);
  const bump = () =>
    RateLimit.findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: resetAt } },
      { upsert: true, new: true, lean: true }
    );

  let row;
  try {
    row = await bump();
  } catch (error) {
    // Two first attempts in the same window can both try to insert the
    // counter; one loses with a duplicate key. The row exists now, so the
    // retry is a plain increment.
    if (error?.code !== 11000) throw error;
    row = await bump();
  }
  return verdict(bucket, row?.count ?? 1, resetAt, now);
}

/** Forget this window's attempts -- after a successful sign-in, say. */
export async function clearRateLimit(bucket, id, now = Date.now()) {
  const { key } = windowKey(bucket, id, now);
  await RateLimit.deleteOne({ _id: key });
}
