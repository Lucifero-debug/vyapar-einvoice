/**
 * The only door to the `users` collection.
 *
 * NOT pure, and one of the documented exceptions in lib/ -- the same as
 * itemLedger.mjs, runningBalances.mjs, cashAccount.mjs, orderClaims.mjs,
 * bomSave.mjs, glAccounts.mjs and openBillsFor.mjs. The rules live in
 * lib/staffRules.mjs, which stays runnable under bare node.
 *
 *
 * WHY THIS MODULE EXISTS AT ALL
 * ----------------------------
 * `models/userModel.js` does NOT carry tenantPlugin, and cannot: signing in
 * has to find a user before anybody belongs to a firm, so there is no tenant
 * in context yet. Fourteen of the seventeen models are scoped automatically
 * and three are not -- companies, totalSales and users.
 *
 * The consequence is easy to miss and expensive to get wrong. Inside a
 * `tenantRoute`-wrapped handler, `runInTenant` is established and every
 * Invoice, Customer and Voucher query filters itself. A `User.find({})` in
 * the same handler does not. It returns EVERY FIRM'S STAFF, silently, with no
 * error and nothing in a log.
 *
 * tenantPlugin's own argument -- "135 call sites is 135 chances to miss one,
 * so make it one place to get right instead" -- applies here with nothing
 * implementing it. This module is that one place. Every function takes
 * `companyId` as its first argument and REFUSES TO RUN WITHOUT ONE, the same
 * way `requireTenant` fails closed rather than quietly querying everything.
 *
 * So the rule the staff routes follow is: they never name `User`. A static
 * sweep in scripts/staff.test.mjs fails the build if one does.
 *
 *
 * WHY findNameClash IS NOT REUSED FOR THE EMAIL CHECK
 * --------------------------------------------------
 * lib/uniqueName.mjs is generic over the model, so `findNameClash(User,
 * "email", ...)` looks like exactly the right call. It is a cross-tenant leak:
 * with no plugin on the schema it searches every firm, and would answer "that
 * email address is already in use" because a DIFFERENT firm employs someone of
 * that name. That is an owner learning something true about another business.
 *
 * `findStaffByEmail` below does it with an explicit companyId and the same
 * collation the unique index was declared with.
 */

import User from "../models/userModel";
import { normalizeEmail, publicStaff } from "./staffRules.mjs";

/**
 * The collation the `{ companyId, email }` unique index was declared with.
 *
 * It has to be repeated here, not merely relied upon. A query without it
 * compares case-sensitively, so "Ravi@shop.com" would look free, pass the
 * clash check, and then be rejected by the index as a raw E11000 -- a 500 with
 * a Mongo error in it rather than "that address is already in use".
 */
const EMAIL_COLLATION = { locale: "en", strength: 2 };

/** Never sent to the browser, and never selected unless asked for by name. */
const SAFE_FIELDS = "name email role active mustChangePassword createdAt lastLoginAt companyId";

export class StaffScopeError extends Error {
  constructor(what) {
    super(`${what} was attempted with no firm. This is a bug: pass auth.companyId.`);
    this.name = "StaffScopeError";
  }
}

/**
 * Fail closed.
 *
 * A missing companyId is a programming mistake, not bad input, and the one
 * thing it must never do is run the query anyway.
 */
const scope = (companyId, what) => {
  const id = String(companyId ?? "").trim();
  if (!id) throw new StaffScopeError(what);
  return id;
};

/** Everyone at this firm, owner included, newest last. */
export async function listStaff(companyId, { session } = {}) {
  const cid = scope(companyId, "Listing staff");
  const rows = await User.find({ companyId: cid }, SAFE_FIELDS, session ? { session } : {})
    .sort({ createdAt: 1 })
    .lean();
  return rows.map(publicStaff);
}

/**
 * How many active owners this firm has.
 *
 * The number both guards in lib/staffRules.mjs turn on. Counted rather than
 * derived from a list the caller happens to hold, so it is right even when the
 * caller's list is stale.
 */
export async function countActiveOwners(companyId, { session } = {}) {
  const cid = scope(companyId, "Counting owners");
  return User.countDocuments(
    { companyId: cid, role: "owner", active: { $ne: false } },
    session ? { session } : {}
  );
}

/**
 * One staff member of THIS firm, or null.
 *
 * Filtered on the id AND the company together, which is what makes another
 * firm's user id come back as null instead of as their record -- the same
 * behaviour tenantPlugin gives `findById` on every other collection.
 */
export async function findStaffById(companyId, id, { session } = {}) {
  const cid = scope(companyId, "Reading a staff member");
  if (!String(id ?? "").trim()) return null;
  try {
    return await User.findOne(
      { _id: id, companyId: cid },
      SAFE_FIELDS,
      session ? { session } : {}
    ).lean();
  } catch {
    // A malformed id is "no such staff member", not a 500 that tells the
    // caller their id was the wrong shape.
    return null;
  }
}

/** The account holding this address at THIS firm, or null. */
export async function findStaffByEmail(companyId, email, { excludeId, session } = {}) {
  const cid = scope(companyId, "Checking an email address");
  const wanted = normalizeEmail(email);
  if (!wanted) return null;

  const filter = { companyId: cid, email: wanted };
  // Leaves the account being edited out of its own comparison, so re-saving
  // somebody without touching their address is not a clash.
  if (excludeId) filter._id = { $ne: excludeId };

  return User.findOne(filter, SAFE_FIELDS, session ? { session } : {})
    .collation(EMAIL_COLLATION)
    .lean();
}

/**
 * The stored hash, for the one operation that needs it.
 *
 * Asked for by name because `passwordHash` carries `select: false`. Nothing
 * else in this module selects it, and the returned object is never handed to
 * a caller that serialises it -- `/api/change-password` compares and discards.
 */
export async function findStaffForPasswordCheck(companyId, id, { session } = {}) {
  const cid = scope(companyId, "Checking a password");
  try {
    return await User.findOne(
      { _id: id, companyId: cid },
      "+passwordHash role active",
      session ? { session } : {}
    ).lean();
  } catch {
    return null;
  }
}

/**
 * Add a staff member to this firm.
 *
 * `companyId` is stamped from the argument, never from the caller's payload --
 * the one field a request must not be able to choose.
 */
export async function createStaff(companyId, { name, email, role, passwordHash, mustChangePassword = true }, { session } = {}) {
  const cid = scope(companyId, "Creating a staff member");

  const [created] = await User.create(
    [
      {
        name: String(name ?? "").trim(),
        email: normalizeEmail(email),
        role,
        passwordHash,
        companyId: cid,
        mustChangePassword: mustChangePassword === true,
        active: true,
        tokenVersion: 0,
      },
    ],
    session ? { session } : {}
  );

  return publicStaff(created.toObject());
}

/**
 * Change a staff member, and end their sessions when the change demands it.
 *
 * `$inc: { tokenVersion: 1 }` is applied in the SAME update as the change, not
 * in a second write. Two writes can half-succeed, and the half that lands
 * first decides which wrong state the firm is left in: an account switched off
 * whose tokens still work, or tokens killed on an account still marked active.
 *
 * Returns null when the id is not this firm's.
 */
export async function updateStaff(companyId, id, patch = {}, { bumpToken = false, session } = {}) {
  const cid = scope(companyId, "Updating a staff member");

  const update = { $set: {} };
  for (const field of ["name", "email", "role", "active", "passwordHash", "mustChangePassword"]) {
    if (patch[field] !== undefined) {
      update.$set[field] = field === "email" ? normalizeEmail(patch[field]) : patch[field];
    }
  }
  if (bumpToken) update.$inc = { tokenVersion: 1 };
  if (!Object.keys(update.$set).length) delete update.$set;

  try {
    const updated = await User.findOneAndUpdate({ _id: id, companyId: cid }, update, {
      new: true,
      runValidators: true,
      projection: SAFE_FIELDS,
      ...(session ? { session } : {}),
    }).lean();
    return updated ? publicStaff(updated) : null;
  } catch (error) {
    if (error?.code === 11000) {
      const clash = new Error("That email address is already in use at this firm.");
      clash.code = 11000;
      throw clash;
    }
    throw error;
  }
}
