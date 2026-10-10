import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Ledger from "../../../models/ledgerModel";
import Customer from "../../../models/custModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handleGET(req, auth) {
  try {
    await connect();
    const { searchParams } = new URL(req.url);
    const customerId = searchParams.get("customerId");

    // 🟡 CASE 1: ALL CUSTOMERS (customerId = "0")
    if (customerId === "0") {
      const [ledgers, customers] = await Promise.all([
        Ledger.find().sort({ date: 1 }).lean(),
        Customer.find().lean(),
      ]);

      return NextResponse.json({
        success: true,
        all: true,
        customers,
        ledgers,
      });
    }

    // 🟡 CASE 2: SPECIFIC CUSTOMER
    if (!customerId) {
      return NextResponse.json(
        { success: false, error: "Customer ID is required (use 0 for all customers)." },
        { status: 400 }
      );
    }

    const customer = await Customer.findById(customerId).lean();
    if (!customer)
      return NextResponse.json(
        { success: false, error: "Customer not found." },
        { status: 404 }
      );

    // `customerName` is whose ledger a row belongs to; `account` is the contra
    // side of that same row. Matching on both meant a cash or bank account
    // pulled in its own aggregate row PLUS every party row naming it as the
    // contra — the same money twice, the second time from the other side's
    // point of view. Every account already gets rows of its own.
    const ledgers = await Ledger.find({ customerName: customer.name })
      .sort({ date: 1 })
      .lean();

    return NextResponse.json({ success: true, customer, ledgers });
  } catch (err) {
    console.error("Ledger API error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch ledger data.", details: err.message },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
