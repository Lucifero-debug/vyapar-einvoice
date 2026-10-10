import { NextResponse } from "next/server";
import Order from "@/models/orderModel";
import Customer from "@/models/custModel";
import Item from "@/models/itemModel";
import State from "@/models/stateModel";
import { getNextOrderNo, raiseOrderCounter } from "@/lib/getNextOrderNo";
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
  isOrderType,
  lineTotal,
  orderStatus,
  orderTotal,
  roundQty,
} from "@/lib/orderStatus.mjs";

/**
 * Take a new sales or purchase order.
 *
 * What the client is NOT allowed to send, and why each is stripped:
 *
 *   invoicedQty  -- only lib/orderClaims.mjs writes it, from a real invoice.
 *                   Accepting it here would let a new order arrive already
 *                   half-billed, with no invoice to account for it.
 *   cancelledQty -- a new order has nothing to cancel. Cancelling happens
 *                   through order-alter, where the billed quantity is checked.
 *   status       -- derived from the lines, here, every time.
 *   totalAmount  -- derived too.
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

    const lines = (body.items || []).filter((l) => l && l.name);
    if (!lines.length) {
      return NextResponse.json(
        { success: false, error: "An order needs at least one item." },
        { status: 400 }
      );
    }

    const newOrder = await withTransaction(async (session) => {
      // Settle the number BEFORE writing, exactly as save-invoice does: the
      // form supplies one from the peek endpoint, which two people opening it
      // at once would both receive, and the unique index turns that into a
      // failed save.
      const requested = Number(body.orderNo);
      let orderNo;

      if (Number.isFinite(requested) && requested > 0) {
        const taken = await Order.findOne(
          { orderNo: requested, type },
          { _id: 1 },
          { session }
        ).lean();
        if (taken) {
          orderNo = await getNextOrderNo(type, session);
        } else {
          orderNo = requested;
          await raiseOrderCounter(type, requested, session);
        }
      } else {
        orderNo = await getNextOrderNo(type, session);
      }

      // The party, read before the write so an unknown one is refused without
      // anything to roll back.
      const customer = await Customer.findOne(
        { name: body.customer?.name },
        BUYER_PROJECTION,
        { session }
      ).lean();

      if (!customer) {
        throw new AbortTransaction({ success: false, error: "Customer not found" });
      }

      const buyer = buyerSnapshot(customer, body.customer);

      // The party's own state decides the place of supply -- the same rule as
      // on an invoice, so the order and the bill it becomes cannot disagree.
      let place = placeOfSupply(buyer);
      if (needsStateLookup(buyer)) {
        const states = await State.find({}, { name: 1, code: 1 }, { session }).lean();
        place = placeOfSupply(buyer, states);
      }

      // Unit code and the goods/service flag come from the item master, never
      // from the page -- the same stamping an invoice line gets.
      const itemMasters = await Item.find(
        { name: { $in: lines.map((i) => i.name).filter(Boolean) } },
        { name: 1, uqc: 1, isService: 1 },
        { session }
      ).lean();

      const items = stampItemLines(lines, itemMasters).map((line) => ({
        name: line.name,
        description: line.description || "",
        hsn: line.hsn || "",
        quantity: roundQty(line.quantity),
        // Not negotiable: a new order has nothing billed and nothing cancelled.
        cancelledQty: 0,
        invoicedQty: 0,
        cost: Number(line.cost) || 0,
        discount: Number(line.discount) || 0,
        total: lineTotal(line),
        deliveryDate: line.deliveryDate ? new Date(line.deliveryDate) : null,
        uqc: line.uqc,
        isService: line.isService,
      }));

      const [order] = await Order.create(
        [
          {
            orderNo,
            type,
            date: body.date ? new Date(body.date) : new Date(),
            deliveryDate: body.deliveryDate ? new Date(body.deliveryDate) : null,
            deliveryDays: Number(body.deliveryDays) || 0,
            customer: buyer,
            stateOfSupply: place.stateOfSupply,
            stateCode: place.stateCode,
            items,
            // Both derived, from the lines that were just built.
            totalAmount: orderTotal(items),
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
            // Sigfa's LUSER. `auth` carries name and email (lib/authServer.mjs).
            createdBy: auth?.name || auth?.email || "",
            editCount: 0,
            printCount: 0,
          },
        ],
        { session }
      );

      return order;
    });

    return NextResponse.json({
      success: true,
      order: newOrder,
      message: `${newOrder.type} order ${newOrder.orderNo} saved`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error creating order:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
