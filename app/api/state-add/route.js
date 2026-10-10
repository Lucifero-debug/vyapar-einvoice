import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import State from "../../../models/stateModel";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { normalizeStateCode } from "@/lib/states.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json();

    const name = normalizeName(body.name);
    const code = normalizeStateCode(body.code);

    if (!name) {
      return NextResponse.json({ success: false, error: "Please enter a state name." }, { status: 400 });
    }
    if (!code) {
      return NextResponse.json(
        { success: false, error: "Please enter a two-digit GST state code, e.g. 07." },
        { status: 400 }
      );
    }

    // Both fields identify the state, so a clash on either is a duplicate.
    const byName = await findNameClash(State, "name", name);
    if (byName) {
      return NextResponse.json(
        { success: false, error: `A state named "${name}" already exists.` },
        { status: 409 }
      );
    }

    const byCode = await findNameClash(State, "code", code);
    if (byCode) {
      return NextResponse.json(
        { success: false, error: `State code ${code} is already used by "${byCode.name || "another state"}".` },
        { status: 409 }
      );
    }

    const state = await State.create({ name, code });
    return NextResponse.json({ success: true, state }, { status: 201 });
  } catch (error) {
    console.error("Error adding state:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
