import { NextResponse } from "next/server";
import {connect} from '../../../lib/mongodb'
import Item from "../../../models/itemModel";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { UQC_DEFAULT, normalizeUqc } from "@/lib/uqc.mjs";


async function handlePOST(req, auth) {
    try {
        await connect()
        const itemData = await req.json();

        // Stock rows are joined to the item master BY NAME, so a duplicate name
        // splits one item's history in two with no way to tell them apart.
        const name = (itemData.name || "").trim();
        if (!name) {
            return NextResponse.json({ error: "Please enter an item name." }, { status: 400 });
        }

        const clash = await findNameClash(Item, "name", name);
        if (clash) {
            return NextResponse.json(
                { error: `An item named "${name}" already exists.` },
                { status: 409 }
            );
        }
    
        const newItem= new Item({
            name:name,
            hsn:itemData.hsn,
            mrp:itemData.mrp,
            unit:itemData.unit,
            cost:itemData.cost,
            salePrice:itemData.salePrice,
            weight:itemData.weight,
            itemType:itemData.itemType,
            purchasePrice:itemData.purchasePrice,
            gst:itemData.gst,
            discount:itemData.discount,
            group:itemData.group,
            openingQuantity:itemData.openBal,
            lastQuantity:itemData.lastBal,
            short:itemData.short,
            // Whitelisted like everything else here, so an unknown code from a
            // stale form cannot be stored. lib/uqc.mjs.
            uqc:normalizeUqc(itemData.uqc) || UQC_DEFAULT,
            isService:Boolean(itemData.isService)
        })
        const savedItem = await newItem.save().catch(err => {
            console.error("Validation Error:", err);
            throw err;
        });
    return NextResponse.json({ message: "Item saved successfully",success:true,savedItem});
    } catch (error) {
        return NextResponse.json({error:error.message},{status:500})
    }
      // Handle saving itemData to your database
  }

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
