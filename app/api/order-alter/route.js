import { NextResponse } from "next/server";
import Order from "@/models/orderModel";
import Customer from "../../../../models/custModel";
import Item from "../../../../models/itemModel";
import State from "../../../../models/stateModel";
import { raiseOrderCounter } from "@/lib/getNextOrderNo";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  BUYER_PROJECTION,
  buyerSnapshot,
  needsStateLookup,
  placeOfSupply,
} from "@/lib/buyerSnapshot.mjs";
import { stampItemLines } from "@/lib/uqc.mjs";
import {
  editBlockedReason,
  isOrderType,
  lineTotal,
  orderStatus,
  orderTotal,
  roundQty,
} from "@/lib/orderStatus.mjs";

/**
 * Amend an order, including cancelling part of a line.
 *
 * THE RULE THAT MAKES THIS SAFE
 * -----------------------------
 * A quantity that has already been billed is history. The order may be raised
 * freely, and the UNBILLED part of a line may be cancelled or removed, but
 * nothing may fall below what has gone out on an invoice -- that would leave
 * a bill claiming against a commitment that no longer covers it, which is the
 * state nobody can reconstruct afterwards. editBlockedReason() in
 * lib/orderStatus.mjs holds the whole check.
 *
 * `invoicedQty` is never read from the request. The stored value is carried
 * across line by line, matched on the subdocument's own _id -- which is also
 * what the invoice line references, so it has to survive an edit.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json();

    const type = String(body.type || "").trim();
    if (!isOrderType(type)) {
      return NextResponse.json(
        { success: false, error: "An order must be a Sale or a Purchase." },
        { status: 400 }
      );
    }

    // The order number is editable on the form, so it cannot also be the
    // lookup key -- the same trap sale-alter documents: changing #5 to #6
    // would find order six and overwrite it.
    const lookupNo = Number(body.originalOrderNo ?? body.orderNo);
    const nextNo = Number(body.orderNo);

    if (!Number.isFinite(lookupNo)) {
      return NextResponse.json(
        { success: false, error: "Order number missing." },
        { status: 400 }
      );
    }

    const updated = await withTransaction(async (session) => {
      const previous = await Order.findOne({ orderNo: lookupNo, type })
        .session(session)
        .lean();

      if (!previous) {
        throw new AbortTransaction({ success: false, error: "Order not found" }, 404);
      }

      // Renumbering onto an order that already exists would destroy it.
      if (Number.isFinite(nextNo) && nextNo !== lookupNo) {
        const clash = await Order.findOne({ orderNo: nextNo, type })
          .session(session)
          .lean();
        if (clash) {
          throw new AbortTransaction({
            success: false,
            error: `${type} order ${nextNo} already exists.`,
          });
        }
      }

      const customer = await Customer.findOne(
        { name: body.customer?.name },
        BUYER_PROJECTION,
        { session }
      ).lean();

      if (!customer) {
        throw new AbortTransaction({ success: false, error: "Customer not found" });
      }

      const buyer = buyerSnapshot(customer, body.customer);

      let place = placeOfSupply(buyer);
      if (needsStateLookup(buyer)) {
        const states = await State.find({}, { name: 1, code: 1 }, { session }).lean();
        place = placeOfSupply(buyer, states);
      }

      const lines = (body.items || []).filter((l) => l && l.name);
      if (!lines.length) {
        throw new AbortTransaction({
          success: false,
          error: "An order needs at least one item.",
        });
      }

      const itemMasters = await Item.find(
        { name: { $in: lines.map((i) => i.name).filter(Boolean) } },
        { name: 1, uqc: 1, isService: 1 },
        { session }
      ).lean();

      // What is already billed, by line id. Carried across from the stored
      // order, never from the request.
      const billed = new Map();
      for (const line of previous.items || []) {
        if (line?._id) billed.set(String(line._id), Number(line.invoicedQty) || 0);
      }

      const items = stampItemLines(lines, itemMasters).map((line) => {
        const id = String(line._id || "").trim();
        const row = {
          name: line.name,
          description: line.description || "",
          hsn: line.hsn || "",
          quantity: roundQty(line.quantity),
          cancelledQty: Math.max(0, roundQty(line.cancelledQty)),
          invoicedQty: id && billed.has(id) ? billed.get(id) : 0,
          cost: Number(line.cost) || 0,
          discount: Number(line.discount) || 0,
          total: lineTotal(line),
          deliveryDate: line.deliveryDate ? new Date(line.deliveryDate) : null,
          uqc: line.uqc,
          isService: line.isService,
        };
        // Keeping the id is what keeps an invoice's reference pointing at the
        // right line. A new line arrives without one and Mongoose assigns it.
        if (id) row._id = id;
        return row;
      });

      // The guard. Checked against the lines as they will be, not as they
      // were sent, so a cancelled quantity counts towards it too.
      const blocked = editBlockedReason(previous.items, items);
      if (blocked) {
        throw new AbortTransaction({ success: false, error: blocked });
      }

      if (Number.isFinite(nextNo) && nextNo !== lookupNo) {
        await raiseOrderCounter(type, nextNo, session);
      }

      const order = await Order.findOneAndUpdate(
        { orderNo: lookupNo, type },
        {
          $set: {
            orderNo: Number.isFinite(nextNo) ? nextNo : lookupNo,
            date: body.date ? new Date(body.date) : previous.date,
            deliveryDate: body.deliveryDate ? new Date(body.deliveryDate) : null,
            deliveryDays: Number(body.deliveryDays) || 0,
            customer: buyer,
            stateOfSupply: place.stateOfSupply,
            stateCode: place.stateCode,
            items,
            totalAmount: orderTotal(items),
            // Derived from the lines that were just built, which is the only
            // honest source now that a cancellation may have closed the order.
            status: orderStatus({ items }),
            reference: body.reference || "",
            quotationNo: body.quotationNo || "",
            paymentTerms: body.paymentTerms || "",
            deliveryPeriod: body.deliveryPeriod || "",
            despatchThrough: body.despatchThrough || "",
            transport: body.transport || "",
            freight: body.freight || "",
            remarks: body.remarks || "",
            hold: Boolean(body.hold),
            updatedBy: auth?.name || auth?.email || "",
          },
          // Sigfa's EDCNT. An order that disagrees with its invoice is the
          // first thing an accountant asks about, and "edited four times" is
          // the answer they want.
          $inc: { editCount: 1 },
        },
        { new: true, session }
      );

      if (!order) {
        throw new AbortTransaction({ success: false, error: "Order not found" }, 404);
      }

      return order;
    });

    return NextResponse.json({
      success: true,
      order: updated,
      message: `${updated.type} order ${updated.orderNo} updated`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error updating order:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
