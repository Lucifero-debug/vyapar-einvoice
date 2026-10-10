import mongoose from "mongoose";
import { NextResponse } from "next/server";
import State from "../../../models/stateModel";
import Customer from "../../../models/custModel";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { normalizeStateCode } from "@/lib/states.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    const id = body.id || body._id;

    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ success: false, error: "Invalid state id." }, { status: 400 });
    }

    const name = normalizeName(body.name);
    const code = normalizeStateCode(body.code);

    if (!name || !code) {
      return NextResponse.json(
        { success: false, error: "A state needs both a name and a two-digit code." },
        { status: 400 }
      );
    }

    // The rename and the cascade onto customers commit together.
    const state = await withTransaction(async (session) => {
      const existing = await State.findById(id).session(session);
      if (!existing) {
        throw new AbortTransaction({ success: false, error: "State not found." }, 404);
      }

      const previousName = existing.name;
      const renamed = name !== previousName;

      const byName = await findNameClash(State, "name", name, { excludeId: id, session });
      if (byName) {
        throw new AbortTransaction(
          { success: false, error: `A state named "${name}" already exists.` },
          409
        );
      }

      const byCode = await findNameClash(State, "code", code, { excludeId: id, session });
      if (byCode) {
        throw new AbortTransaction(
          { success: false, error: `State code ${code} is already used by "${byCode.name || "another state"}".` },
          409
        );
      }

      existing.set({ name, code });
      await existing.save({ session });

      // Parties carry the state by name, and their stateCode is a copy of this
      // one, so both follow the master rather than drifting from it.
      if (renamed) {
        await Customer.updateMany(
          { state: previousName },
          { $set: { state: name, stateCode: code } },
          { session }
        );
      } else {
        await Customer.updateMany(
          { state: name },
          { $set: { stateCode: code } },
          { session }
        );
      }

      return existing;
    });

    return NextResponse.json({ success: true, state });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("Error updating state:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
