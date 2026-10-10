import { NextResponse } from "next/server";
import mongoose from "mongoose";
import Customer from '../../../models/custModel'
import Invoice from '../../../models/invoiceModel'
import Ledger from '../../../models/ledgerModel'
import ItemLedger from '../../../models/itemLedgerModel'
import Voucher from '../../../models/voucherModel'
import { applyDelta, modeOf, round2, toSigned } from '@/lib/balance.mjs'
import { withTransaction, AbortTransaction } from '@/lib/withTransaction.mjs'
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { normalizeStateCode } from '@/lib/gst.mjs'
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
    try {
        const customerData = await req.json();
        const customerId = customerData.id;

        if (!mongoose.isValidObjectId(customerId)) {
            return NextResponse.json({ error: "Invalid customer id." }, { status: 400 });
        }

        // The rename cascade and the balance adjustment commit together: a
        // half-applied rename leaves history under two different names.
        const updatedCustomer = await withTransaction(async (session) => {
            const existing = await Customer.findById(customerId).session(session);
            if (!existing) {
                throw new AbortTransaction({ error: "Customer not found" }, 404);
            }

            const previousName = existing.name;
            const nextName = (customerData.name || "").trim() || previousName;
            const renamed = nextName !== previousName;

            // Merging two parties' history by renaming one onto the other is
            // never what anybody means.
            if (renamed) {
                const clash = await findNameClash(Customer, "name", nextName, {
                    excludeId: customerId,
                    session,
                });
                if (clash) {
                    throw new AbortTransaction(
                        { error: `A customer named "${nextName}" already exists.` },
                        409
                    );
                }
            }

            // The form sends magnitude + Dr/Cr; storage is signed.
            const openingSigned  = toSigned(customerData.openBal, customerData.openingMode);
            const lastYearSigned = toSigned(customerData.lastBal, customerData.lastMode);

            // `lastBal` is the running balance, not a form field. It is only
            // touched here to keep the invariant
            //     lastBal = openingBal + every posting since
            // true when the opening balance itself is corrected. It used to be
            // overwritten wholesale from the form, so editing any unrelated
            // field rewrote the balance with whatever was on screen.
            const openingDelta = round2(openingSigned - (Number(existing.openingBal) || 0));
            if (openingDelta !== 0) {
                applyDelta(existing, openingDelta);
            }

            existing.set({
                name: nextName,
                email: customerData.email,
                openingBal: openingSigned,
                openingMode: modeOf(openingSigned),
                lastYearBal: lastYearSigned,
                lastYearMode: modeOf(lastYearSigned),
                address: customerData.address,
                pincode: customerData.pincode,
                phone: customerData.phone,
                city: customerData.city,
                state: customerData.state,
                gstIn: customerData.gstIn,
                pan: customerData.pan,
                aadhar: customerData.aadhar,
                bank: customerData.bank,
                interest: customerData.interest,
                discount: customerData.discount,
                group: customerData.group,
                stateCode: normalizeStateCode(customerData.stateCode),
                short: customerData.short,
                dealerType: customerData.dealerType,
            });

            await existing.save({ session });

            // Ledger rows identify a party by NAME, not by reference, so a
            // rename used to orphan the customer's entire history: nothing
            // under the new name, and the old rows unreachable.
            if (renamed) {
                await Promise.all([
                    Ledger.updateMany(
                        { customerName: previousName },
                        { $set: { customerName: nextName } },
                        { session }
                    ),
                    // The contra side of somebody else's row can name this
                    // party too.
                    Ledger.updateMany(
                        { account: previousName },
                        { $set: { account: nextName } },
                        { session }
                    ),
                    ItemLedger.updateMany(
                        { partyName: previousName },
                        { $set: { partyName: nextName } },
                        { session }
                    ),
                    Invoice.updateMany(
                        { "customer.name": previousName },
                        { $set: { "customer.name": nextName } },
                        { session }
                    ),
                    Voucher.updateMany(
                        { acName: previousName },
                        { $set: { acName: nextName } },
                        { session }
                    ),
                    Voucher.updateMany(
                        { "customers.name": previousName },
                        { $set: { "customers.$[line].name": nextName } },
                        { session, arrayFilters: [{ "line.name": previousName }] }
                    ),
                ]);
            }

            return existing;
        });

        return NextResponse.json({
            message: "Customer Updated successfully",
            success: true,
            updatedCustomer,
        });
    } catch (error) {
        if (error instanceof AbortTransaction) {
            return NextResponse.json(error.payload, { status: error.status });
        }
        console.error("Update Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
