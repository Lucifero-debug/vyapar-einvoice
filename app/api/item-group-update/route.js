import mongoose from "mongoose";
import { NextResponse } from "next/server";
import ItemGroup from "@/models/itemGroupModel";
import Item from "@/models/itemModel";
import {
  itemGroupProblems,
  normalizeItemGroup,
  sameGroup,
} from "@/lib/itemGroups.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Alter an item group.
 *
 * THE WHOLE RECORD COMES BACK. `normalizeItemGroup` fills every field from
 * the body, so a dialog that posted only the boxes it shows would clear the
 * rest — the contract lib/masterActions.mjs upholds for every master here.
 *
 * THE RENAME CASCADES, AND IT HAS TO BE ALL OR NOTHING. Two things hold this
 * group's name rather than a reference to it:
 *
 *   - every ITEM in it (`items.group`), which is how every report that
 *     groups goods already reads it, and
 *   - every CHILD group (`underGroup`), which is how the tree is held
 *     together.
 *
 * Renaming the row without them would leave items filed under a group that is
 * no longer in the picker and children hanging off a parent that no longer
 * exists. So the rename and both cascades commit together or none of them do.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    const id = body.id || body._id;

    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ success: false, error: "Invalid group id." }, { status: 400 });
    }

    const draft = normalizeItemGroup(body);

    const itemGroup = await withTransaction(async (session) => {
      const existing = await ItemGroup.findById(id).session(session);
      if (!existing) {
        throw new AbortTransaction({ success: false, error: "Group not found." }, 404);
      }

      // Every OTHER group. This row is left out of its own comparison, or
      // re-saving it unchanged would report it as a duplicate of itself and
      // as its own ancestor.
      const others = await ItemGroup.find(
        { _id: { $ne: id } },
        { name: 1, mainGroup: 1, underGroup: 1 }
      )
        .session(session)
        .lean();

      const problems = itemGroupProblems(draft, others);
      if (problems.length) {
        const taken = /already exists/.test(problems[0]);
        throw new AbortTransaction({ success: false, error: problems[0] }, taken ? 409 : 400);
      }

      const previousName = existing.name;
      const renamed = !sameGroup(previousName, draft.name);

      existing.set(draft);
      await existing.save({ session });

      if (renamed && previousName) {
        // Case-insensitively, because the box was free text before this
        // master existed and holds whatever was typed onto each item.
        const collation = { locale: "en", strength: 2 };

        await Item.updateMany(
          { group: previousName },
          { $set: { group: draft.name } },
          { session, collation }
        );

        await ItemGroup.updateMany(
          { underGroup: previousName, _id: { $ne: id } },
          { $set: { underGroup: draft.name } },
          { session, collation }
        );
      }

      return existing;
    });

    return NextResponse.json({ success: true, itemGroup });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    if (error?.code === 11000) {
      return NextResponse.json(
        { success: false, error: "That group already exists." },
        { status: 409 }
      );
    }
    console.error("Error updating item group:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
