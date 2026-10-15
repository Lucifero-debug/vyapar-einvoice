import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import ItemGroup from "@/models/itemGroupModel";
import Item from "@/models/itemModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Delete an item group.
 *
 * REFUSED WHILE ANYTHING STILL POINTS AT IT, like every other master in this
 * app. Two things can:
 *
 *   - ITEMS, which hold the group by name. Deleting one still in use would
 *     leave them filed under a group that is no longer on the list -- and
 *     there would be no way to pick that value again on the next item.
 *   - CHILD GROUPS, which hold their parent by name. Deleting a parent would
 *     leave them hanging off nothing, which is the orphan
 *     `itemGroupOptions` has to keep showing so somebody can fix it.
 *
 * Both are counted case-insensitively, because the field was free text before
 * this master existed. An exact match would report a group as unused and then
 * orphan everything spelled differently.
 */
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

    const group = await ItemGroup.findById(id);
    if (!group) {
      return NextResponse.json({ error: "Group not found." }, { status: 404 });
    }

    const collation = { locale: "en", strength: 2 };

    const [items, children] = await Promise.all([
      Item.countDocuments({ group: group.name }).collation(collation),
      ItemGroup.countDocuments({ underGroup: group.name, _id: { $ne: id } }).collation(collation),
    ]);

    if (items) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot delete "${group.name}" because ${items} ${
            items === 1 ? "item is" : "items are"
          } in it. Move them to another group first.`,
        },
        { status: 409 }
      );
    }

    if (children) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot delete "${group.name}" because ${children} ${
            children === 1 ? "group sits" : "groups sit"
          } under it. Move them first.`,
        },
        { status: 409 }
      );
    }

    const deletedGroup = await ItemGroup.findByIdAndDelete(id);

    return NextResponse.json({
      success: true,
      message: "Item group deleted successfully",
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
