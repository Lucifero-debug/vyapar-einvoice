import { NextResponse } from "next/server";
import Item from "../../../models/itemModel";
import ItemLedger from "../../../models/itemLedgerModel";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { UQC_DEFAULT, normalizeUqc } from "@/lib/uqc.mjs";

async function handlePOST(req, auth) {
    try {
        const itemData = await req.json();
        const itemId = itemData.id;

        // The rename cascade commits with the item itself, so stock history
        // cannot end up split across two names.
        const updatedItem = await withTransaction(async (session) => {
            const existing = await Item.findById(itemId).session(session);
            if (!existing) {
                throw new AbortTransaction({ error: "Item not found." }, 404);
            }

            const previousName = existing.name;
            const nextName = (itemData.name || "").trim() || previousName;
            const renamed = nextName !== previousName;

            if (renamed) {
                const clash = await findNameClash(Item, "name", nextName, {
                    excludeId: itemId,
                    session,
                });
                if (clash) {
                    throw new AbortTransaction(
                        { error: `An item named "${nextName}" already exists.` },
                        409
                    );
                }
            }

            existing.set({
                name: nextName,
                hsn: itemData.hsn,
                mrp: itemData.mrp,
                unit: itemData.unit,
                cost: itemData.cost,
                salePrice: itemData.salePrice,
                weight: itemData.weight,
                itemType: itemData.itemType,
                purchasePrice: itemData.purchasePrice,
                gst: itemData.gst,
                discount: itemData.discount,
                group: itemData.group,
                short: itemData.short,
                openingQuantity: itemData.openBal,
                lastQuantity: itemData.lastBal,
                uqc: normalizeUqc(itemData.uqc) || UQC_DEFAULT,
                isService: Boolean(itemData.isService),
            });

            await existing.save({ session });

            // Stock rows identify an item by NAME, so a rename used to strand
            // every movement the item had ever had.
            if (renamed) {
                await ItemLedger.updateMany(
                    { itemName: previousName },
                    { $set: { itemName: nextName } },
                    { session }
                );
            }

            return existing;
        });

        return NextResponse.json({
            message: "Item updated successfully",
            success: true,
            updatedItem,
        });
    } catch (error) {
        if (error instanceof AbortTransaction) {
            return NextResponse.json(error.payload, { status: error.status });
        }
        console.error("Update Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
