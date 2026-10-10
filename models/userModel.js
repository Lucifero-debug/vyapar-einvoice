import mongoose from "mongoose";

/**
 * Somebody who can sign in, and the firm they belong to.
 *
 * A user belongs to exactly one company. Staff at two firms get two accounts;
 * it keeps "which books am I looking at" an unambiguous property of the
 * session rather than something to pick after signing in.
 */
const userSchema = new mongoose.Schema(
  {
    // Stored lowercased and trimmed so "Owner@Shop.com" and "owner@shop.com"
    // are one account rather than two.
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true, default: "" },
    // The scrypt string from lib/password.mjs. Never a plain password, and
    // never selected by default -- see the `select: false` below, which keeps
    // it out of every query that does not deliberately ask for it.
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      required: true,
      enum: ["owner", "accountant", "biller"],
      default: "biller",
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "companies",
      required: true,
      index: true,
    },
    // Bumped to kill every outstanding session for this user. Sessions are
    // stateless and cannot be deleted server-side, so this is how somebody who
    // has left is actually locked out before their token expires.
    tokenVersion: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

// One account per email per firm. Scoped to the company rather than global, so
// a person using the same address at two firms is not blocked by the first.
// Case-insensitive so a stray capital cannot create a second account.
userSchema.index(
  { companyId: 1, email: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

const User = mongoose.models.users || mongoose.model("users", userSchema);

export default User;
