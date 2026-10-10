/**
 * The one line a route needs.
 *
 *     export const GET = tenantRoute(async (req, auth) => { ... });
 *
 * It signs the caller in, checks the permission the path demands, and runs the
 * handler with every query scoped to their firm. A route that is not wrapped
 * does not read the wrong firm's rows -- its first query throws, because the
 * schema plugin refuses to run without a tenant in context.
 */

import { NextResponse } from "next/server";
import { requireAuth, AuthError } from "./authServer.mjs";
import { runInTenant, TenantMissingError } from "./tenantContext.mjs";

export function tenantRoute(handler, options = {}) {
  return async function wrapped(req, ctx) {
    let auth;
    try {
      auth = await requireAuth(req, options);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json(
          { success: false, error: error.message, message: error.message },
          { status: error.status }
        );
      }
      throw error;
    }

    try {
      // TEMPORARY DIAGNOSTIC — REMOVE
      console.log(
        `[tenant] WRAP ${req.method} ${new URL(req.url).pathname} companyId=${JSON.stringify(auth.companyId)}`
      );
      return await runInTenant(auth.companyId, () => handler(req, auth, ctx));
    } catch (error) {
      // A tenant that never got established is a bug in this file, not bad
      // input. Say so plainly rather than leaking it as a generic 500.
      if (error instanceof TenantMissingError) {
        console.error("Tenant scoping error:", error.message);
        return NextResponse.json(
          { success: false, error: "Server misconfiguration.", message: "Server misconfiguration." },
          { status: 500 }
        );
      }
      throw error;
    }
  };
}

export default tenantRoute;
