import Item from '../../../models/itemModel'
import {connect} from '../../../lib/mongodb'
import { NextResponse } from 'next/server'
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
    try {
        await connect()
        const itemdata=await req.json(); 
        console.log("fool",itemdata)
        const value=itemdata.value
        const item= await Item.find({   
            $or: [
                 { _id: value },
                { name: value },       // Searching by name
                { group: value },      // Searching by group
                { customer: value }    // Searching by customer (adjust the field name accordingly)
            ]
        });
        if (item.length === 0) {
            return NextResponse.json({ message: "No matching item found", success: false });
        }
        const final=item[0]
        return NextResponse.json({message:"Item fetched successfully",success:true,final})
    } catch (error) {
        return NextResponse.json({error:error.message},{status:500})
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
