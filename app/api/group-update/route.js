import mongoose from "mongoose";
import { NextResponse } from "next/server";
import CustomerGroup, { isReservedGroup } from "../../../models/customerGroupModel";
import Customer from "../../../models/custModel";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    const id = body.id || body._id;

    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ success: false, error: "Invalid group id." }, { status: 400 });
    }

    const nextName = (body.name || "").trim();
    if (!nextName) {
      return NextResponse.json(
        { success: false, error: "Please enter a group name." },
        { status: 400 }
      );
    }

    // The rename and the cascade commit together: a half-applied rename would
    // leave some customers under the old name and some under the new one.
    const group = await withTransaction(async (session) => {
      const existing = await CustomerGroup.findById(id).session(session);
      if (!existing) {
        throw new AbortTransaction({ success: false, error: "Group not found." }, 404);
      }

      const previousName = existing.name;
      const renamed = nextName !== previousName;

      // Cash and Bank are how an invoice finds the account to settle into
      // (lib/cashAccount.mjs matches on these group names). Renaming one would
      // leave a cash sale with nowhere to post its receipt.
      if (renamed && isReservedGroup(previousName)) {
        throw new AbortTransaction(
          {
            success: false,
            error: `"${previousName}" cannot be renamed — invoices use it to find the account they settle into.`,
          },
          409
        );
      }

      if (renamed) {
        const clash = await findNameClash(CustomerGroup, "name", nextName, {
          excludeId: id,
          session,
        });
        if (clash) {
          throw new AbortTransaction(
            { success: false, error: `A group named "${nextName}" already exists.` },
            409
          );
        }
      }

      existing.set({ name: nextName, note: body.note });
      await existing.save({ session });

      // Customers carry the group by name, so they move with it.
      if (renamed) {
        await Customer.updateMany(
          { group: previousName },
          { $set: { group: nextName } },
          { session }
        );
      }

      return existing;
    });

    return NextResponse.json({ success: true, group });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("Error updating customer group:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
