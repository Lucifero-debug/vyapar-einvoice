import mongoose from "mongoose";

/**
 * One rate-limit counter: one caller, one bucket, one time window.
 *
 * NOT tenant-scoped, deliberately, like users and companies: sign-in and
 * sign-up are counted before anybody has a firm. The key holds no firm data
 * and no personal data -- it is a hash (lib/rateLimit.mjs windowKey).
 *
 * `expiresAt` carries a TTL index, so MongoDB deletes each counter once its
 * window has passed. Nothing else ever reads an old one.
 */
const rateLimitSchema = new mongoose.Schema(
  {
    _id: { type: String },
    // No default: on the first attempt the upsert's $inc creates it as 1, and a
    // default would make Mongoose add a conflicting $setOnInsert for it.
    count: { type: Number },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RateLimit = mongoose.models.ratelimits || mongoose.model("ratelimits", rateLimitSchema);

export default RateLimit;
