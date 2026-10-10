import { NextResponse } from "next/server";
import {connect} from '../../../lib/mongodb'
import Customer from '../../../models/custModel'
import { toSigned, modeOf } from '@/lib/balance.mjs'
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";


async function handlePOST(req, auth) {
    try {
        await connect()
        const customerData = await req.json();

        // Parties are joined BY NAME across the ledger, the stock ledger,
        // invoices and vouchers. Two parties sharing a name makes both their
        // ledgers ambiguous for good, so the name is claimed here. (The alter
        // route has always checked this; creating never did.)
        const name = (customerData.name || "").trim();
        if (!name) {
            return NextResponse.json({ error: "Please enter a name." }, { status: 400 });
        }

        const clash = await findNameClash(Customer, "name", name);
        if (clash) {
            return NextResponse.json(
                { error: `A party named "${name}" already exists.` },
                { status: 409 }
            );
        }
        // The form sends magnitude + Dr/Cr; storage is signed.
        const openingSigned  = toSigned(customerData.openBal, customerData.openingMode);
        const lastYearSigned = toSigned(customerData.lastBal, customerData.lastMode);

        const newCustomer= new Customer({
            name:name,
            email:customerData.email,
            openingBal:openingSigned,
            openingMode:modeOf(openingSigned),
            // A new party has no transactions yet, so the running balance IS
            // the opening balance. It used to be seeded from the "last year"
            // field, which is unrelated master data.
            lastBal:openingSigned,
            lastMode:modeOf(openingSigned),
            lastYearBal:lastYearSigned,
            lastYearMode:modeOf(lastYearSigned),
            address:customerData.address,
            pincode:customerData.pincode,
            phone:customerData.phone,
            city:customerData.city,
            state:customerData.state,
            gstIn:customerData.gstIn,
            stateCode:customerData.stateCode,
            pan:customerData.pan,
            aadhar:customerData.aadhar,
            bank:customerData.bank,
            interest:customerData.interest,
            discount:customerData.discount,
            group:customerData.group,
            short:customerData.short,
            dealerType:customerData.dealerType
        })

        const savedCustomer = await newCustomer.save().catch(err => {
            console.error("Validation Error:", err);
            throw err;
        });

        return NextResponse.json({ message: "Customer saved successfully", success: true, savedCustomer });
    } catch (error) {
        return NextResponse.json({error:error.message},{status:500})
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
