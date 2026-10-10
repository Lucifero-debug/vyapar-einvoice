import {connect} from '../../../lib/mongodb'
import { NextResponse } from 'next/server'
import Customer from '../../../models/custModel';
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
    try {
        await connect()
        const customerdata=await req.json(); 
        const value=customerdata.value
        const customer= await Customer.find({   
            $or: [
                    { _id: value },
                { name: value },       // Searching by name
                { group: value },      // Searching by group
            ]
        });
        if (customer.length === 0) {
            return NextResponse.json({ message: "No matching customer found", success: false });
        }

        const final=customer[0]
        return NextResponse.json({message:"Item fetched successfully",success:true,final})
    } catch (error) {
        return NextResponse.json({error:error.message},{status:500})
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
