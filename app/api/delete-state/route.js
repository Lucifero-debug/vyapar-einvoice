import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import State from "../../../models/stateModel";
import Customer from "../../../models/custModel";
import Invoice from "../../../models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();

    const id = new URL(req.url).searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Id missing in query." }, { status: 400 });
    }
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid state id." }, { status: 400 });
    }

    const state = await State.findById(id);
    if (!state) {
      return NextResponse.json({ error: "State not found." }, { status: 404 });
    }

    // Parties and invoices hold the state by name. Deleting one still in use
    // would leave them pointing at a state that is no longer on the list.
    const [parties, invoices] = await Promise.all([
      Customer.countDocuments({ state: state.name }),
      Invoice.countDocuments({ stateOfSupply: state.name }),
    ]);

    if (parties || invoices) {
      const used = [
        parties && `${parties} ${parties === 1 ? "party" : "parties"}`,
        invoices && `${invoices} invoice${invoices === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" and ");

      return NextResponse.json(
        {
          success: false,
          error: `Cannot delete "${state.name}" because ${used} use it.`,
        },
        { status: 409 }
      );
    }

    const deletedState = await State.findByIdAndDelete(id);

    return NextResponse.json({
      success: true,
      message: "State deleted successfully",
      deletedState,
    });
  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
