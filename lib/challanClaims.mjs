/**
 * The one place an invoice touches a challan's billed quantities.
 *
 * Impure, like lib/orderClaims.mjs which it mirrors: it loads and saves
 * through Mongoose, and the arithmetic is all in lib/challanStatus.mjs.
 * Three routes move challan quantities -- save-invoice claims, delete-invoice
 * releases, sale-alter does both -- and none of them touches `billedQty`
 * itself (scripts/challans.test.mjs checks).
 *
 * Always inside the caller's transaction: an invoice that committed while its
 * challan's claim rolled back would leave goods billed and still "pending".
 */

import Challan from "../models/challanModel";
import { AbortTransaction } from "./withTransaction.mjs";
import {
  CHALLAN_KINDS,
  applyBilled,
  challanStatus,
  claimsFromItems,
  netClaims,
} from "./challanStatus.mjs";

const applyToChallan = async ({ session, challanNo, challanType, byLine }) => {
  const label = `${CHALLAN_KINDS[challanType]?.label || "Challan"} ${challanNo}`;
  const challan = await Challan.findOne({ challanNo, type: challanType }).session(session).lean();
  if (!challan) {
    throw new AbortTransaction({
      success: false,
      error: `${label} no longer exists. Remove it from the bill, or restore the challan.`,
    });
  }
  const { items, problems } = applyBilled(challan, byLine);
  if (problems.length) {
    throw new AbortTransaction({ success: false, error: `${label}: ${problems.join(" ")}` });
  }
  const status = challanStatus({ items });
  await Challan.updateOne({ challanNo, type: challanType }, { $set: { items, status } }, { session });
  return { challanNo, challanType, status };
};

const settle = async ({ session, items, sign }) => {
  const touched = [];
  for (const group of claimsFromItems(items)) {
    const byLine = new Map();
    for (const [lineId, want] of group.byLine) byLine.set(lineId, sign * want);
    touched.push(
      await applyToChallan({ session, challanNo: group.challanNo, challanType: group.challanType, byLine })
    );
  }
  return touched;
};

/** An invoice was raised: take its quantities off the challans it bills. */
export const claimChallanQty = ({ session, items }) => settle({ session, items, sign: +1 });

/** An invoice was deleted: hand its quantities back to the challans. */
export const releaseChallanQty = ({ session, items }) => settle({ session, items, sign: -1 });

/** An invoice was edited: move each challan by the difference only. */
export const reconcileChallanQty = async ({ session, before, after }) => {
  const touched = [];
  for (const group of netClaims(before, after)) {
    touched.push(
      await applyToChallan({
        session,
        challanNo: group.challanNo,
        challanType: group.challanType,
        byLine: group.byLine,
      })
    );
  }
  return touched;
};
