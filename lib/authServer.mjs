/**
 * The server-side guard every protected route calls.
 *
 * NOT pure -- it reads the database -- so it lives apart from lib/roles.mjs
 * and lib/session.mjs, which are, and which the edge middleware imports.
 *
 * TWO LAYERS, ON PURPOSE
 * ----------------------
 *   middleware.js  signature + expiry + role-for-path. No database, so it runs
 *                  at the edge and turns away the bulk of bad traffic cheaply.
 *   requireAuth()  everything above PLUS the checks that need a database: is
 *                  the user still active, is the firm still active, and is the
 *                  token's version still current.
 *
 * The middleware is a gate, not the lock. A route that skips requireAuth() is
 * still reachable by anyone holding a token that has since been revoked.
 */

import Company from "@/models/companyModel";
import User from "@/models/userModel";
import { connect } from "@/lib/mongodb";
import { SESSION_COOKIE, verifySession } from "@/lib/session.mjs";
import { can, permissionForPath } from "@/lib/roles.mjs";

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const secret = () => {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) {
    // Loud rather than silent: without a secret nothing can be signed, and a
    // fallback default would be the same as having no auth at all.
    throw new AuthError("AUTH_SECRET is not configured on the server.", 500);
  }
  return value;
};

/**
 * Who is making this request, verified against the database.
 *
 * Throws AuthError, so a route can let it reach its catch block and answer
 * with `error.status`.
 */
export async function requireAuth(req, { permission } = {}) {
  const token = req.cookies?.get?.(SESSION_COOKIE)?.value;
  const claims = await verifySession(token, secret());
  if (!claims) throw new AuthError("Please sign in.", 401);

  await connect();

  const user = await User.findById(claims.uid)
    .select("email name role companyId tokenVersion active")
    .lean();

  if (!user || user.active === false) throw new AuthError("Please sign in.", 401);

  // The session says which firm; the user record is the authority. If they
  // disagree, the token is stale or forged -- either way, not a session.
  if (String(user.companyId) !== String(claims.cid)) {
    throw new AuthError("Please sign in.", 401);
  }

  // Revocation: bumping tokenVersion invalidates every token already issued.
  if ((user.tokenVersion || 0) !== (claims.v || 0)) {
    throw new AuthError("Your session has ended. Please sign in again.", 401);
  }

  const company = await Company.findById(user.companyId).select("name active").lean();
  if (!company || company.active === false) {
    throw new AuthError("This account is not active.", 403);
  }

  // The role on the USER, never the one in the token: a role changed while a
  // session was open must take effect on the next request, not in a week.
  const needed = permission ?? permissionForPath(new URL(req.url).pathname);
  if (needed && !can(user.role, needed)) {
    throw new AuthError("You do not have permission to do that.", 403);
  }

  return {
    userId: String(user._id),
    companyId: String(user.companyId),
    role: user.role,
    email: user.email,
    name: user.name,
    company,
  };
}
