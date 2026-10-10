/**
 * Which firm the current request belongs to.
 *
 * Held in an AsyncLocalStorage rather than threaded through every function,
 * because the alternative was adding a `companyId` argument to 135 call sites
 * across 49 files -- and the one that got missed would not fail, it would
 * quietly serve another customer's books.
 *
 * The store is set once per request by `tenantRoute()` and read by the schema
 * plugin on every query. Nothing else should touch it.
 *
 * node:async_hooks, so this is server-only. It must never be imported by a
 * client component or by the edge middleware.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

// ===================== TEMPORARY DIAGNOSTIC — REMOVE =====================
// If two different instance ids appear, this module has been loaded twice and
// the store set by one is invisible to the other. If one id appears but the
// read says NO STORE, the context is being lost across an await instead.
const INSTANCE = Math.random().toString(36).slice(2, 8);
console.log(`[tenant] module instance ${INSTANCE} loaded`);
// ==========================================================================

/** Run `fn` with every query inside it scoped to this firm. */
export function runInTenant(companyId, fn) {
  const id = String(companyId || "");
  if (!id) throw new TenantMissingError("runInTenant() needs a company id.");
  console.log(`[tenant] SET  ${INSTANCE} -> ${id}`); // TEMPORARY DIAGNOSTIC
  return storage.run({ companyId: id }, fn);
}

/** The current firm, or null outside a request. */
export const currentTenant = () => {
  const store = storage.getStore(); // TEMPORARY DIAGNOSTIC
  console.log(`[tenant] READ ${INSTANCE} -> ${store ? store.companyId : "NO STORE"}`);
  return store?.companyId || null;
};

/**
 * The current firm, or throw.
 *
 * This is the whole safety property. A query that runs with no tenant in
 * context does not fall back to "all firms" -- it fails, loudly, with a
 * message naming the collection. A route that forgets to establish the tenant
 * is then a 500 on the first request anyone makes to it, which is noticed, as
 * opposed to a silent cross-tenant read, which is not.
 */
export function requireTenant(what = "this query") {
  const id = currentTenant();
  if (!id) {
    throw new TenantMissingError(
      `${what} ran with no company in context. Wrap the route in tenantRoute().`
    );
  }
  return id;
}

export class TenantMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantMissingError";
    this.status = 500;
  }
}

/**
 * Escape hatch for work that is legitimately outside any one firm: the
 * migration script, and the sign-in path, which has to find a user before it
 * knows which firm they belong to.
 *
 * Deliberately awkward to type and easy to grep for. Every use should be
 * obvious from its name at the call site.
 */
export const runAcrossAllTenants = (fn) => storage.run({ companyId: null, unscoped: true }, fn);

/** True when the current context deliberately spans every firm. */
export const isUnscoped = () => storage.getStore()?.unscoped === true;
