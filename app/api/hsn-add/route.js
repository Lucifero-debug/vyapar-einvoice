import { NextResponse } from "next/server";
import {connect} from '../../../lib/mongodb'
import Hsn from "../../../models/hsnModel";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json();

    const { hsncode, hsnname, gst, gstunit } = body;

    if (!hsncode || !gst) {
      return new Response(JSON.stringify({ success: false, error: 'HSN and GST are required' }), {
        status: 400,
      });
    }

    // Items carry the HSN by code, so two codes differing only in case or in
    // stray whitespace would split one group's items across both.
    const code = normalizeName(hsncode);
    const existing = await findNameClash(Hsn, "hsncode", code);
    if (existing) {
      return new Response(
        JSON.stringify({ success: false, error: `HSN code "${code}" already exists.` }),
        { status: 409 }
      );
    }

    const newHsn = await Hsn.create({ hsncode: code, hsnname, gst, gstunit });

    return new Response(JSON.stringify({ success: true, hsn: newHsn }), {
      status: 201,
    });
  } catch (error) {
    console.error('❌ Error adding HSN:', error);
    return new Response(JSON.stringify({ success: false, error: 'Internal Server Error' }), {
      status: 500,
    });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
