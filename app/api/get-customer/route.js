import {connect} from '../../../lib/mongodb'
import { NextResponse } from 'next/server'
import Customer from '../../../models/custModel'
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handleGET(req, auth) {
    try {
        await connect()
        const customer=await Customer.find({})
        return NextResponse.json({message:"Customer fetched successfully",success:true,customer})
    } catch (error) {
        return NextResponse.json({error:error.message},{status:500})
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
