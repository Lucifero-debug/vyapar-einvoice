'use client';
export const dynamic = "force-dynamic";

import React, { Suspense, useEffect, useState } from "react";
import { companyAddress } from '@/lib/company.mjs';
import { useCompany } from '@/context/CompanyContext';
import ItemLedgerSearchParams from "../../components/ItemLedgerSearchParams";

const formatQty = (num = 0) => parseFloat(num).toFixed(2);

export default function ItemLedgerPage() {
  // The firm whose documents these are -- never a hardcoded one.
  const { company } = useCompany();
  const [itemId, setItemId] = useState("");
  const [item, setItem] = useState(null);
  const [ledgers, setLedgers] = useState([]);
  const [allItems, setAllItems] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // Fetch item ledger data
  useEffect(() => {
    if (!itemId) return;

    const fetchItemLedger = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/item-ledger?itemId=${itemId}`);
        if (!res.ok) throw new Error("Failed to fetch item ledger data.");
        const data = await res.json();
if (data.all) {
  // handle all items case
  setAllItems(data.items || []);
  setLedgers(data.ledgers || []);
} else {
  setItem(data.item || null);
  setLedgers(data.ledgers || []);
}

      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchItemLedger();
  }, [itemId]);

  // Date window. Movements before it fold into opening stock rather than being
  // dropped: starting a filtered period from the item's original opening
  // quantity is what made every date-filtered stock report wrong.
  const from = fromDate ? new Date(fromDate) : null;
  const to = toDate ? new Date(toDate) : null;
  if (to) to.setHours(23, 59, 59, 999);

  const placeInWindow = (entry) => {
    const on = new Date(entry.date);
    if (from && on < from) return "before";
    if (to && on > to) return "after";
    return "inside";
  };

  const movement = (entry) =>
    (entry.receiptQuantity || 0) - (entry.issueQuantity || 0);

  // Group every row, splitting each item's into what precedes the window and
  // what falls inside it.
  const groupByItemName = (data) => {
    return data.reduce((acc, entry) => {
      const itemName = entry.itemName || "Unknown Item";
      if (!acc[itemName]) acc[itemName] = { before: [], inside: [] };
      const place = placeInWindow(entry);
      if (place === "before") acc[itemName].before.push(entry);
      else if (place === "inside") acc[itemName].inside.push(entry);
      return acc;
    }, {});
  };

  if (!itemId)
    return (
      <>
        <Suspense fallback={null}>
          <ItemLedgerSearchParams onValue={setItemId} />
        </Suspense>
        <div className="page-shell text-center text-sm text-destructive">No item selected.</div>
      </>
    );

  if (loading) return <div className="page-shell text-center text-sm text-muted-foreground">Loading Item Ledger...</div>;
  if (error) return <div className="page-shell text-center text-sm text-destructive">Error: {error}</div>;

  const groupedItems = groupByItemName(
    [...ledgers].sort((a, b) => new Date(a.date) - new Date(b.date))
  );

  // ==========================
  // 🧮 Render
  // ==========================
  return (
    <>
      <Suspense fallback={null}>
        <ItemLedgerSearchParams onValue={setItemId} />
      </Suspense>

      <div className="page-shell">
        {/* Header */}
        <div className="doc-head">
          <h2 className="doc-org">{company.name}</h2>
          <p className="doc-meta">{companyAddress(company)}</p>
          <p className="doc-kind">
            STOCK LEDGER {item ? `- ${item.name}` : ""}
          </p>
        </div>

        {/* Date Filters */}
        <div className="no-print mb-6 flex flex-wrap items-end justify-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="field">
            <label className="field-label">From:</label>
            <input
              type="date"
              className="field-input w-44"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">To:</label>
            <input
              type="date"
              className="field-input w-44"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>

          <button
            type="button"
            onClick={() => window.print()}
            className="btn btn-secondary"
          >
            Print
          </button>
        </div>

        {/* Multiple Item Tables */}
{Object.entries(groupedItems).length > 0 ? (
  Object.entries(groupedItems).map(([itemName, { before, inside }], idx) => {
    // 🧮 Initialize running balance and totals
const currentItem =
  itemId === "0"
    ? allItems.find((i) => i.name === itemName)
    : item;

// Stock as at the START OF THE WINDOW: the item's own opening quantity plus
// every movement that precedes it. With no from-date, `before` is empty and
// this is just the opening quantity.
let runningQty =
  (currentItem?.openingQuantity || 0) +
  before.reduce((sum, e) => sum + movement(e), 0);

    // The opening row carries a quantity like any other, so it counts towards
    // the column totals — otherwise the columns do not add up to their totals.
    let totalReceipt = runningQty > 0 ? runningQty : 0;
    let totalIssue = runningQty < 0 ? Math.abs(runningQty) : 0;
    // 🟡 Create opening balance entry
    const openingEntry = {
      date: from || (inside.length > 0 ? inside[0].date : new Date()),
      invoiceNo: "-",
      typeOfVoucher: from ? "Opening Stock (as at from-date)" : "Opening Stock",
      partyName: "-",
      receiptQuantity: runningQty > 0 ? runningQty : 0,
      issueQuantity: runningQty < 0 ? Math.abs(runningQty) : 0,
      balanceQuantity: runningQty,
      isOpening: true,
    };

    // 🧾 Process entries with running balance
    const computedEntries = inside.map((entry) => {
      const receipt = entry.receiptQuantity || 0;
      const issue = entry.issueQuantity || 0;
      runningQty += receipt - issue;
      totalReceipt += receipt;
      totalIssue += issue;

      return {
        ...entry,
        balanceQuantity: runningQty,
      };
    });

    // Combine both
    const allEntries = [openingEntry, ...computedEntries];

    // Final balance after all entries
    const finalBalance = runningQty;

    return (
      <div key={idx} className="mb-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Item Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/60 px-4 py-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground">
            {itemName.toUpperCase()}
          </h3>
          <span className="chip">({inside.length} Entries)</span>
        </div>

        {/* Table */}
        <div className="overflow-x-auto"><table className="data-table min-w-[720px]">
          <thead>
            <tr>
              <th className="w-[10%]">DATE</th>
              <th className="w-[10%]">INVOICE NO.</th>
              <th className="w-[15%]">TYPE OF VOUCHER</th>
              <th className="w-[25%]">PARTY NAME</th>
              <th className="w-[10%] text-right">RECEIPT QTY</th>
              <th className="w-[10%] text-right">ISSUE QTY</th>
              <th className="w-[10%] text-right">BALANCE QTY</th>
            </tr>
          </thead>
          <tbody>
            {allEntries.map((entry, i) => (
              <tr
                key={i}
                className={entry.isOpening ? "row-opening" : ""}
              >
                <td className="">
                  {entry.date ? new Date(entry.date).toLocaleDateString("en-IN") : "N/A"}
                </td>
                <td className="">{entry.invoiceNo || "-"}</td>
                <td className="">{entry.typeOfVoucher}</td>
                <td className="">{entry.partyName}</td>
                <td className="money-dr">
                  {entry.receiptQuantity ? formatQty(entry.receiptQuantity) : ""}
                </td>
                <td className="money-cr">
                  {entry.issueQuantity ? formatQty(entry.issueQuantity) : ""}
                </td>
                <td className="num font-semibold">
                  {formatQty(entry.balanceQuantity)}
                </td>
              </tr>
            ))}
          </tbody>

          {/* 🟢 TOTAL ROW */}
          <tfoot>
            <tr>
              <td colSpan="4" className="num">
                TOTAL:
              </td>
              <td className="money-dr">
                {formatQty(totalReceipt)}
              </td>
              <td className="money-cr">
                {formatQty(totalIssue)}
              </td>
              <td className="num font-semibold">
                {formatQty(finalBalance)}
              </td>
            </tr>
          </tfoot>
        </table></div>
      </div>
    );
  })
) : (
  <div className="empty-state">
    No item ledger entries found for this item within the selected date range.
  </div>
)}

      </div>
    </>
  );
}
