import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { acknowledgeStockAlert, syncStockAlerts } from "@/lib/stockAlertSync.mjs";
import { alertCounts, alertView } from "@/lib/stockAlerts.mjs";

export const dynamic = "force-dynamic";

/**
 * The persistent low-stock alerts.
 *
 *   GET   bring the alerts up to date with the stock, then list the open ones
 *   POST  { id }  acknowledge one, as the signed-in user
 *
 * lib/stockAlerts.mjs has the rules: one open alert per item while it stays
 * low, updated when it gets worse, resolved when it recovers.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const { alerts, changes } = await syncStockAlerts();
    return NextResponse.json({ success: true, alerts: alertView(alerts), counts: alertCounts(alerts), changes });
  } catch (err) {
    console.error("Stock alerts error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Which alert?" }, { status: 400 });
    }
    // Tenant-scoped by the plugin: another firm's alert id is simply not found.
    const alert = await acknowledgeStockAlert({ id, by: auth?.name || auth?.email || "" });
    if (!alert) {
      return NextResponse.json(
        { success: false, error: "That alert is no longer open." },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, alert: alertView([alert])[0] });
  } catch (err) {
    console.error("Stock alert acknowledge error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const GET = tenantRoute(handleGET);
// Reading the alerts needs report:read (lib/roles.mjs). Acknowledging one is
// a write, so the route asks for master:write instead -- `permission`
// REPLACES the path's rule in requireAuth (lib/authServer.mjs); the edge
// middleware still checks report:read on the path first. Every role that
// holds report:read today also holds master:write, so nobody loses anything;
// a read-only role added later will not be able to clear alerts by default.
export const POST = tenantRoute(handlePOST, { permission: "master:write" });
