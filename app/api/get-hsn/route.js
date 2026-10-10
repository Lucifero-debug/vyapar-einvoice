// app/api/get-hsn/route.js
import {connect} from '../../../lib/mongodb'
import Hsn from '@/models/hsnModel';
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handleGET(req, auth) {
  try {
    await connect();

    const hsnList = await Hsn.find() // optional sort


    return new Response(JSON.stringify({ success: true, hsn: hsnList }), {
      status: 200,
    });
  } catch (error) {
    console.error('❌ Error fetching HSN codes:', error);
    return new Response(JSON.stringify({ success: false, error: 'Internal Server Error' }), {
      status: 500,
    });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
