/**
 * Building a challan document from checked input, inside a transaction.
 *
 * Shared by challan-add and challan-alter so the two cannot disagree about
 * what a saved challan looks like. Impure: it reads the party, the states and
 * the item master through Mongoose.
 */

import Customer from "../models/custModel";
import Item from "../models/itemModel";
import State from "../models/stateModel";
import { AbortTransaction } from "./withTransaction.mjs";
import { BUYER_PROJECTION, buyerSnapshot, needsStateLookup, placeOfSupply } from "./buyerSnapshot.mjs";
import { stampItemLines } from "./uqc.mjs";
import { partyProblem, unknownItems } from "./invoiceInput.mjs";
import { challanKind, challanStatus, challanTotals } from "./challanStatus.mjs";
import { mriFields } from "./mriSave.mjs";

/**
 * The fields to store, from `prepareChallanInput` output. `items` must
 * already carry each line's `billedQty` (0 on a new challan,
 * `carryBilled` on an edit).
 */
export async function challanFields({ session, input, items, previous = null }) {
  const kind = challanKind(input.type);

  const problem = partyProblem(input.customer.name);
  if (problem) throw new AbortTransaction({ success: false, error: problem }, 400);

  const customer = await Customer.findOne({ name: input.customer.name }, BUYER_PROJECTION, { session }).lean();
  if (!customer) {
    throw new AbortTransaction(
      { success: false, error: `"${input.customer.name}" is not in your accounts. Create the ${kind.partyRole} first.` },
      400
    );
  }
  const buyer = buyerSnapshot(customer, input.customer);
  let place = placeOfSupply(buyer);
  if (needsStateLookup(buyer)) {
    const states = await State.find({}, { name: 1, code: 1 }, { session }).lean();
    place = placeOfSupply(buyer, states);
  }

  // Every line must be one of THIS firm's items: a challan with stock effect
  // writes stock rows, and a row for an item nobody's master knows is stock
  // that cannot be found again. Tenant-scoped, so another firm's item is
  // simply missing.
  const itemMasters = await Item.find(
    { name: { $in: items.map((i) => i.name) } },
    { name: 1, uqc: 1, isService: 1 },
    { session }
  ).lean();
  const missing = unknownItems(items, itemMasters);
  if (missing.length) {
    throw new AbortTransaction(
      { success: false, error: `Not in your item master: ${missing.join(", ")}. Add the item first.` },
      400
    );
  }

  // A purchase M.R.I.: its number, and any Ag. MRI No. (lib/mriSave.mjs).
  const mri = await mriFields({ session, mri: input.mri, previous, party: buyer.name, items });

  const stamped = stampItemLines(items, itemMasters);
  const totals = challanTotals(stamped);

  return {
    type: input.type,
    date: input.date,
    customer: buyer,
    stateOfSupply: place.stateOfSupply,
    stateCode: place.stateCode,
    items: stamped,
    stockEffect: input.stockEffect,
    taxableAmount: totals.taxable,
    gstAmount: totals.gst,
    totalAmount: totals.total,
    status: challanStatus({ items: stamped }),
    partyChallanNo: input.partyChallanNo,
    partyChallanDate: input.partyChallanDate,
    transport: input.transport,
    vehicleNo: input.vehicleNo,
    grNo: input.grNo,
    grDate: input.grDate,
    ewayBillNo: input.ewayBillNo,
    ewayBillDate: input.ewayBillDate,
    shippedTo: input.shippedTo,
    remarks: input.remarks,
    mriNo: mri.mriNo,
    mriRemark: mri.mriRemark,
    againstMriNo: mri.againstMriNo,
  };
}
