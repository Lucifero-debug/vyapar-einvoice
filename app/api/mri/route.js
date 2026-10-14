import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Invoice from "@/models/invoiceModel";
import Challan from "@/models/challanModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { istDayWindow } from "@/lib/istDate.mjs";
import {
  isMriView,
  mriRegister,
  partyWiseRejected,
  pendingMris,
  rejectedMaterial,
} from "@/lib/mri.mjs";

/**
 * Purchase M.R.I. registers -- SIGFA's MRI book, "List Of Pending MRI",
 * "Rejected Material Register" and "Party Wise Rejected Material".
 *
 *   /api/mri?view=register|pending|rejected|party&party=Acme&from=2026-04-01&to=2026-10-14
 *
 * Read-only. Reads every purchase bill and purchase challan that is an MRI
 * or a Re-MRI, and lets lib/mri.mjs do every figure. The date range filters
 * the MRIs themselves, AFTER the Re-MRIs have been matched to them: an MRI
 * from March whose Re-MRI came in April is not pending, whichever month is
 * shown.
 */
const FIELDS = {
  invoiceNo: 1,
  challanNo: 1,
  date: 1,
  customer: 1,
  partyBillNo: 1,
  partyChallanNo: 1,
  mriNo: 1,
  mriRemark: 1,
  againstMriNo: 1,
  "items.name": 1,
  "items.quantity": 1,
  "items.receivedQty": 1,
  "items.cost": 1,
  "items.discount": 1,
  "items.uqc": 1,
};

async function handleGET(req) {
  try {
    const url = new URL(req.url);
    const view = String(url.searchParams.get("view") || "register").trim();
    if (!isMriView(view)) {
      return NextResponse.json({ success: false, error: "Not an M.R.I. report." }, { status: 400 });
    }
    const party = String(url.searchParams.get("party") || "").trim();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if ([from, to].some((d) => d && Number.isNaN(new Date(d).getTime()))) {
      return NextResponse.json({ success: false, error: "That is not a date." }, { status: 400 });
    }

    await connect();
    const isMriDoc = { $or: [{ mriNo: { $type: "number" } }, { againstMriNo: { $type: "number" } }] };
    const [invoices, challans] = await Promise.all([
      Invoice.find({ type: "Purchase", return: { $ne: true }, ...isMriDoc }, FIELDS).lean(),
      Challan.find({ type: "Purchase", ...isMriDoc }, FIELDS).lean(),
    ]);
    const docs = [
      ...invoices.map((d) => ({ ...d, source: "invoice" })),
      ...challans.map((d) => ({ ...d, source: "challan" })),
    ];

    // Indian calendar days, as every other report cuts them.
    const start = from ? istDayWindow(from)?.from : null;
    const end = to ? istDayWindow(to)?.to : null;
    const keep = (row) => {
      if (party && row.party.toLowerCase() !== party.toLowerCase()) return false;
      const t = row.date ? new Date(row.date).getTime() : null;
      if (start && (t === null || t < start.getTime())) return false;
      if (end && (t === null || t >= end.getTime())) return false;
      return true;
    };

    let rows;
    if (view === "register") rows = mriRegister(docs).filter(keep);
    else if (view === "pending") rows = pendingMris(docs).filter(keep);
    else {
      const rejected = rejectedMaterial(docs).filter(keep);
      rows = view === "rejected" ? rejected : partyWiseRejected(rejected);
    }

    return NextResponse.json({ success: true, view, rows });
  } catch (err) {
    console.error("Error reading M.R.I. register:", err);
    return NextResponse.json({ success: false, error: "The M.R.I. register could not be read." }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const GET = tenantRoute(handleGET);
