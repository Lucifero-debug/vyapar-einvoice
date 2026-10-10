import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import CustomerGroup, { isReservedGroup } from "../../../models/customerGroupModel";
import Customer from "../../../models/custModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();

    const id = new URL(req.url).searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Id missing in query." }, { status: 400 });
    }
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid group id." }, { status: 400 });
    }

    const group = await CustomerGroup.findById(id);
    if (!group) {
      return NextResponse.json({ error: "Group not found." }, { status: 404 });
    }

    if (isReservedGroup(group.name)) {
      return NextResponse.json(
        {
          success: false,
          error: `"${group.name}" cannot be deleted — invoices use it to find the account they settle into.`,
        },
        { status: 409 }
      );
    }

    // Customers hold the group by name; deleting one still in use would leave
    // them filed under a group that no longer exists and is not in the picker.
    const inUse = await Customer.countDocuments({ group: group.name });
    if (inUse) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot delete "${group.name}" because ${inUse} ${
            inUse === 1 ? "party is" : "parties are"
          } in it. Move them to another group first.`,
        },
        { status: 409 }
      );
    }

    const deletedGroup = await CustomerGroup.findByIdAndDelete(id);

    return NextResponse.json({
      success: true,
      message: "Group deleted successfully",
      deletedGroup,
    });
  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
