import Voucher from '../../../models/voucherModel';
import {connect} from '../../../lib/mongodb'
import { NextResponse } from 'next/server'
import { tenantRoute } from "@/lib/tenantRoute.mjs";

// In your /api/get-item.js (or .ts) file
export const dynamic = "force-dynamic";  // Forces this route to be dynamic
export const revalidate = 1;  // Optional: Set revalidation time (in seconds)


async function handleGET(req, auth) {
    try {
        await connect()
        const voucher=await Voucher.find({})
        return NextResponse.json({message:"Voucher fetched successfully",success:true,voucher})
    } catch (error) {
        return NextResponse.json({error:error.message},{status:500})
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
