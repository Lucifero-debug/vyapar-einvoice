/**
 * Purchase M.R.I. against the database: the number series, the Ag. MRI No.
 * check and the "used in a Re-MRI" guard. Shared by save-invoice, sale-alter,
 * challan-add, challan-alter and both delete routes, so an MRI on a bill and
 * an MRI on a challan follow one rule. The rules themselves are lib/mri.mjs.
 *
 * Every query is tenant-scoped (lib/tenantPlugin.mjs): another firm's MRI is
 * simply not found.
 */

import Counter from "../models/counterModel";
import Invoice from "../models/invoiceModel";
import Challan from "../models/challanModel";
import { AbortTransaction } from "./withTransaction.mjs";
import { MRI_COUNTER, againstMriProblem, hasRejection, referencedReason } from "./mri.mjs";

const MRI_PROJECTION = {
  invoiceNo: 1,
  challanNo: 1,
  type: 1,
  return: 1,
  date: 1,
  mriNo: 1,
  againstMriNo: 1,
  "customer.name": 1,
  "items.name": 1,
  "items.quantity": 1,
  "items.receivedQty": 1,
};

const opts = (session) => (session ? { session } : {});

/** The MRI with this number, from bills or challans, tagged with its source. */
export async function findMri(mriNo, session = null) {
  if (!(Number(mriNo) > 0)) return null;
  const inv = await Invoice.findOne(
    { mriNo: Number(mriNo), type: "Purchase", return: { $ne: true } },
    MRI_PROJECTION,
    opts(session)
  ).lean();
  if (inv) return { ...inv, source: "invoice" };
  const ch = await Challan.findOne({ mriNo: Number(mriNo), type: "Purchase" }, MRI_PROJECTION, opts(session)).lean();
  return ch ? { ...ch, source: "challan" } : null;
}

/**
 * A document raised against `mriNo` (a Re-MRI), other than `excludeId`.
 */
export async function findReMri(mriNo, { session = null, excludeId = null } = {}) {
  if (!(Number(mriNo) > 0)) return null;
  const notSelf = excludeId ? { _id: { $ne: excludeId } } : {};
  const inv = await Invoice.findOne({ againstMriNo: Number(mriNo), ...notSelf }, MRI_PROJECTION, opts(session)).lean();
  if (inv) return { ...inv, source: "invoice" };
  const ch = await Challan.findOne({ againstMriNo: Number(mriNo), ...notSelf }, MRI_PROJECTION, opts(session)).lean();
  return ch ? { ...ch, source: "challan" } : null;
}

/**
 * Reserve the next MRI number. One series across bills and challans, as
 * SIGFA keeps one "MRI Series"; nudged past the highest number already used
 * on either, like the other counters.
 */
export async function getNextMriNo(session = null) {
  // One after the other: a transaction's session takes one operation at a
  // time.
  const inv = await Invoice.findOne({ mriNo: { $type: "number" } }, { mriNo: 1 }, opts(session)).sort({ mriNo: -1 }).lean();
  const ch = await Challan.findOne({ mriNo: { $type: "number" } }, { mriNo: 1 }, opts(session)).sort({ mriNo: -1 }).lean();
  const highest = Math.max(Number(inv?.mriNo) || 0, Number(ch?.mriNo) || 0);
  if (highest) {
    await Counter.updateOne({ name: MRI_COUNTER }, { $max: { value: highest } }, { upsert: true, ...opts(session) });
  }
  const counter = await Counter.findOneAndUpdate(
    { name: MRI_COUNTER },
    { $inc: { value: 1 } },
    { new: true, upsert: true, ...opts(session) }
  );
  return counter.value;
}

/** The next MRI number, without reserving it. */
export async function peekNextMriNo() {
  const [inv, ch, counter] = await Promise.all([
    Invoice.findOne({ mriNo: { $type: "number" } }, { mriNo: 1 }).sort({ mriNo: -1 }).lean(),
    Challan.findOne({ mriNo: { $type: "number" } }, { mriNo: 1 }).sort({ mriNo: -1 }).lean(),
    Counter.findOne({ name: MRI_COUNTER }).lean(),
  ]);
  return Math.max(Number(inv?.mriNo) || 0, Number(ch?.mriNo) || 0, Number(counter?.value) || 0) + 1;
}

/**
 * The MRI fields to store on a bill or challan being saved.
 *
 *   mri       `{ on, remark, againstMriNo }` from lib/mri.mjs parseMriHeader
 *   previous  the stored document, on an edit
 *   party     the supplier's name as stored
 *
 * Throws AbortTransaction with a sentence when the request cannot stand.
 * Returns `{ mriNo, mriRemark, againstMriNo }`; all null when it is not an MRI.
 */
export async function mriFields({ session, mri, previous = null, party, items = [] }) {
  const before = Number(previous?.mriNo) || null;

  if (!mri?.on) {
    if (before) {
      // Turning an MRI off would leave the Re-MRI raised against it pointing
      // at nothing.
      const re = await findReMri(before, { session, excludeId: previous?._id });
      const blocked = referencedReason(previous, re);
      if (blocked) throw new AbortTransaction({ success: false, error: blocked }, 409);
    }
    return { mriNo: null, mriRemark: null, againstMriNo: null };
  }

  if (before) {
    // Its rejections may already have been taken in again on a Re-MRI: then
    // it keeps its supplier, and keeps rejecting something.
    const re = await findReMri(before, { session, excludeId: previous?._id });
    if (re && previous?.customer?.name && previous.customer.name !== party) {
      throw new AbortTransaction(
        { success: false, error: `${referencedReason(previous, re)} The supplier cannot change.` },
        409
      );
    }
    if (re && !hasRejection({ items })) {
      throw new AbortTransaction(
        { success: false, error: `${referencedReason(previous, re)} It has to keep the material it rejected.` },
        409
      );
    }
  }

  const againstMriNo = mri.againstMriNo || null;
  if (againstMriNo) {
    const target = await findMri(againstMriNo, session);
    const claimedBy = await findReMri(againstMriNo, { session, excludeId: previous?._id });
    const problem = againstMriProblem({ againstMriNo, target, party, self: before, claimedBy });
    if (problem) throw new AbortTransaction({ success: false, error: problem }, 400);
    // Touch the MRI being re-inspected, in this transaction. Two Re-MRIs
    // saved against it at once -- or a Re-MRI saved while it is altered or
    // deleted -- then write the same document, and MongoDB lets only one of
    // them commit; the other is retried and refused by the check above.
    const Model = target.source === "challan" ? Challan : Invoice;
    await Model.updateOne({ _id: target._id }, { $inc: { mriLock: 1 } }, opts(session));
  }

  const mriNo = before || (await getNextMriNo(session));
  return { mriNo, mriRemark: mri.remark || "", againstMriNo };
}

/**
 * Before deleting a bill or challan: refuse while a Re-MRI points at it.
 * Throws AbortTransaction; returns nothing.
 */
export async function assertMriDeletable(doc, session = null) {
  if (!(Number(doc?.mriNo) > 0)) return;
  const re = await findReMri(doc.mriNo, { session, excludeId: doc._id });
  const blocked = referencedReason(doc, re);
  if (blocked) {
    throw new AbortTransaction({ success: false, error: blocked.replace("Can't change it", "Can't delete") }, 409);
  }
}
