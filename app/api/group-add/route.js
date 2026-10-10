import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import CustomerGroup from "../../../models/customerGroupModel";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json();

    const name = (body.name || "").trim();
    if (!name) {
      return NextResponse.json(
        { success: false, error: "Please enter a group name." },
        { status: 400 }
      );
    }

    // Customers are filed under the group's NAME, so two groups differing only
    // in case would be the same group to everything that reads it.
    const clash = await findNameClash(CustomerGroup, "name", name);
    if (clash) {
      return NextResponse.json(
        { success: false, error: `A group named "${name}" already exists.` },
        { status: 409 }
      );
    }

    const group = await CustomerGroup.create({ name, note: body.note });

    return NextResponse.json({ success: true, group }, { status: 201 });
  } catch (error) {
    console.error("Error adding customer group:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
