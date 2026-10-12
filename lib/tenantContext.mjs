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

// Which copy of this module is running, and how many contexts it has set.
// Used only in the server-log diagnosis when a query runs with no tenant:
// two instance ids mean the module was loaded twice; one id with sets seen
// means the context was lost across an await. (The per-request SET/READ
// logging that found this is gone -- it logged every query of every request,
// with the firm's id.)
const INSTANCE = Math.random().toString(36).slice(2, 8);
let setsSeen = 0;

/** Run `fn` with every query inside it scoped to this firm. */
export function runInTenant(companyId, fn) {
  const id = String(companyId || "");
  if (!id) throw new TenantMissingError("runInTenant() needs a company id.");
  setsSeen += 1;
  return storage.run({ companyId: id }, fn);
}

/** The current firm, or null outside a request. */
export const currentTenant = () => {
  const store = storage.getStore();
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
  if (id) return id;

  // TWO DIFFERENT FAULTS, and the old single message conflated them.
  //
  // It said "Wrap the route in tenantRoute()" whatever had gone wrong, which
  // has now sent two separate debugging sessions after a wrapper that was
  // already there -- once on the billing routes, once on the order report.
  // When every route IS wrapped, that sentence is actively misleading: the
  // fault is not a missing wrapper but a context that was established and
  // then lost, and the two are fixed in completely different places.
  const store = storage.getStore();

  if (store) {
    // The request DID establish a context, but with nothing in it. Nothing in
    // this file can produce that -- runInTenant() refuses a blank id -- so it
    // is runAcrossAllTenants() leaking into a request path.
    throw new TenantMissingError(
      `${what} ran inside a deliberately unscoped context. ` +
        `Something reached runAcrossAllTenants() on a normal request path; ` +
        `grep for it. The route wrapper is not the problem.`
    );
  }

  // === EVIDENCE, not advice ===
  //
  // The previous message described the two possible faults and asked the
  // reader to go and find out which. That is the wrong division of labour:
  // everything needed to tell them apart is available HERE, at the throw.
  //
  //   setsSeen === 0   nothing ever called runInTenant() on this module
  //                    instance. Either the route is unwrapped, or there is a
  //                    second copy of this file and the wrapper used that one.
  //   setsSeen  >  0   this instance HAS established contexts, so the wrapper
  //                    works and this particular query escaped its chain.
  //
  // The stack is printed because it names the exact call path, which no
  // amount of grepping the route can reconstruct.
  const diagnosis =
    setsSeen === 0
      ? `This module instance (${INSTANCE}) has never established a context, ` +
        `so either the route is not wrapped in tenantRoute(), or a SECOND ` +
        `copy of lib/tenantContext.mjs is serving the wrapper.`
      : `This module instance (${INSTANCE}) has established ${setsSeen} ` +
        `context(s), so tenantRoute() works and THIS query escaped its async ` +
        `chain. The stack below names where.`;

  const error = new TenantMissingError(`${what} ran with no company in context. ${diagnosis}`);
  // Printed rather than only thrown: a route's own catch turns this into a
  // JSON error message and the stack never reaches the log otherwise, which
  // is why two rounds of this went undiagnosed.
  console.error(`[tenant] NO STORE on instance ${INSTANCE} after ${setsSeen} set(s)`);
  console.error(error.stack);
  throw error;
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
