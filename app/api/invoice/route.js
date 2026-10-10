import {connect} from '../../../lib/mongodb'
import { NextResponse } from 'next/server'
import Invoice from '../../../models/invoiceModel';
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
    try {
        await connect()
        const invoicedata=await req.json(); 
        const value=parseInt(invoicedata.value)
        const invoice= await Invoice.find({   
            $or: [
                { invoiceNo: value },       // Searching by name
            ]
        });
        if (invoice.length === 0) {
            return NextResponse.json({ message: "No matching invoice found", success: false });
        }

        const final=invoice[0]
        return NextResponse.json({message:"Invoice fetched successfully",success:true,final})
    } catch (error) {
        return NextResponse.json({error:error.message},{status:500})
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
