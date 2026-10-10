import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Order from "@/models/orderModel";
import Invoice from "@/models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { isOrderType } from "@/lib/orderStatus.mjs";
import { reconcileOrders } from "@/lib/orderReports.mjs";

/**
 * Does the order book agree with the invoices?
 *
 *   /api/order-reconcile?type=Sale
 *
 * WHY THIS EXISTS
 * ---------------
 * Sigfa stores no running total on an order line: in their live file INVQTY
 * mirrors QTY and DESPQTY is filled on one line of 702. What they DO maintain
 * is the reference the other way -- 9,260 of their 12,413 invoice lines name
 * the sales order line they fulfil -- so their pending figure is derived by
 * joining, every time it is asked for. A derived figure cannot drift.
 *
 * This project keeps a counter instead (`invoicedQty`, moved by
 * lib/orderClaims.mjs inside the invoice's own transaction), because a stored
 * figure can refuse an over-bill at the moment of saving and reads without a
 * join. The cost of that choice is that it CAN drift, and silently: an order
 * would simply report the wrong pending quantity for ever.
 *
 * So this route pays the cost back. It derives the billed quantity Sigfa's
 * way and lists every line where the two disagree. An empty list is the
 * answer you want, and is also the thing to run straight after importing a
 * client's Sigfa data to prove the migration was clean.
 *
 * It is deliberately NOT part of /api/order-report: it reads the whole
 * invoice collection, which is a much heavier query than the order book, and
 * nobody wants that behind a page they open to glance at pending orders.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const type = String(new URL(req.url).searchParams.get("type") || "").trim();

    const orderQuery = isOrderType(type) ? { type } : {};

    // Only the invoice lines that reference an order, and only the four
    // fields the comparison needs. A projection rather than whole documents:
    // on a real book this is tens of thousands of rows, and none of the
    // buyer block, the tax or the IRN matters here.
    const [orders, invoices] = await Promise.all([
      Order.find(orderQuery, { orderNo: 1, type: 1, items: 1 }).lean(),
      Invoice.find(
        { "items.orderNo": { $gt: 0 } },
        { "items.name": 1, "items.quantity": 1, "items.orderNo": 1, "items.orderType": 1, "items.orderLineId": 1, return: 1, invoiceNo: 1 }
      ).lean(),
    ]);

    // Flatten, carrying the invoice's own `return` flag down onto each line.
    // A credit note's lines hold the order reference of the bill they
    // reverse -- that is how the form prefilled them -- so the rule has to
    // be able to tell them apart or it subtracts the quantity twice.
    const invoiceLines = [];
    for (const invoice of invoices) {
      for (const line of invoice.items || []) {
        if (!line) continue;
        invoiceLines.push({
          ...line,
          isReturn: Boolean(invoice.return),
          invoiceNo: invoice.invoiceNo,
        });
      }
    }

    const problems = reconcileOrders({ orders, invoiceLines });

    return NextResponse.json({
      success: true,
      type: isOrderType(type) ? type : "",
      checked: {
        orders: orders.length,
        orderLines: orders.reduce((n, o) => n + (o.items || []).length, 0),
        invoiceLines: invoiceLines.length,
      },
      agreed: problems.length === 0,
      rows: problems,
    });
  } catch (err) {
    console.error("Error reconciling orders:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
