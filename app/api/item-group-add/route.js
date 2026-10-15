import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import ItemGroup from "@/models/itemGroupModel";
import { itemGroupProblems, normalizeItemGroup } from "@/lib/itemGroups.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Create an item group — Sigfa's `Masters > Item Group`, Save.
 *
 * THE RULES ARE NOT HERE. `normalizeItemGroup` builds the whole row and
 * `itemGroupProblems` says what is wrong with it, both in lib/itemGroups.mjs,
 * so the screen and the two routes refuse the same things for the same
 * reasons. A check copied into a route is a check that drifts.
 *
 * The existing groups are read first because the refusals need them: a
 * duplicate name, a parent that is not a group, and a parent that is already
 * somewhere beneath this one — a loop, which would hang every later walk of
 * the tree.
 */
async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json();

    const draft = normalizeItemGroup(body);

    // Everything else of this firm's. Nothing is left out here, because
    // nothing exists yet to leave out.
    const existing = await ItemGroup.find({}, { name: 1, mainGroup: 1, underGroup: 1 }).lean();

    const problems = itemGroupProblems(draft, existing);
    if (problems.length) {
      // 409 for a name already taken, 400 for anything the person can fix by
      // choosing differently -- the same split every other master uses.
      const taken = /already exists/.test(problems[0]);
      return NextResponse.json(
        { success: false, error: problems[0] },
        { status: taken ? 409 : 400 }
      );
    }

    const itemGroup = await ItemGroup.create(draft);

    return NextResponse.json({ success: true, itemGroup }, { status: 201 });
  } catch (error) {
    // The unique index is the last word: two people adding the same group at
    // once both pass the check above and one of them loses here.
    if (error?.code === 11000) {
      return NextResponse.json(
        { success: false, error: "That group already exists." },
        { status: 409 }
      );
    }
    console.error("Error adding item group:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
