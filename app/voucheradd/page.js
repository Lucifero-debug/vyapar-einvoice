"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import VoucherSearchParams from "@/components/VoucherSearchparams";
import PartyBalance from "@/components/PartyBalance";
import BillAdjust from "@/components/BillAdjust";
import { allocatedTotal, billTypeFor, lineAmount } from "@/lib/billAdjust.mjs";

const AddVoucher = () => {
  const [voucherParams, setVoucherParams] = useState({ type: "", value: "" });

  const [form, setForm] = useState({
    acName: "",
    date: new Date().toISOString().slice(0, 10),
    againstBill: false,
    acType: "",
    narration: "", // 🔹 Added main narration
  });

  const [entries, setEntries] = useState([
    { name: "", debit: "", credit: "", custId: "", narration: "", allocations: [] },
  ]);

  const [customers, setCustomers] = useState([]);

  // Which line's bill picker is open, by index. Sigfa's "Against Bill" is a
  // per-line thing: one voucher can settle two parties' bills at once.
  const [adjusting, setAdjusting] = useState(null);

  // --- existing fetch logic unchanged ---
  useEffect(() => {
    const fetchCust = async () => {
      try {
        const response = await fetch("/api/get-customer");
        const result = await response.json();
        setCustomers(result.customer || []);
      } catch (error) {
        console.error("Error fetching customer data:", error);
        alert("Failed to fetch customer.");
      }
    };

    fetchCust();
  }, []);

  // --- existing voucher fetch logic unchanged (just add narration) ---
  useEffect(() => {
    if (voucherParams.value && customers.length > 0) {
      const fetchVoucher = async () => {
        try {
          const res = await fetch("/api/voucher", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: voucherParams.value }),
          });

          const result = await res.json();
          const voucher = result.final;
          if (!voucher) throw new Error("Voucher not found");

          setForm({
            acName: voucher.acName || "",
            date:
              voucher.date?.slice(0, 10) ||
              new Date().toISOString().slice(0, 10),
            againstBill: voucher.againstBill || false,
            acType: voucher.acType || "",
            narration: voucher.narration || "", // 🔹 load main narration
          });

          setEntries(
            voucher.customers?.map((custEntry) => {
              const found = customers.find((c) => c.name === custEntry.name);
              return {
                name: custEntry.name || "",
                debit: custEntry.debit?.toString() || "",
                credit: custEntry.credit?.toString() || "",
                custId: found?._id || "",
                narration: custEntry.narration || "", // 🔹 load customer narration
                // What this line already settles, so reopening a voucher
                // does not quietly drop its adjustment on the next save.
                allocations: custEntry.allocations || [],
              };
            }) || [{ name: "", debit: "", credit: "", custId: "", narration: "", allocations: [] }]
          );
        } catch (err) {
          console.error("Failed to fetch voucher:", err);
          alert("Failed to load voucher.");
        }
      };

      fetchVoucher();
    }
  }, [voucherParams.value, customers]);

  // --- form change ---
  const handleFormChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  // --- entry change ---
  const handleEntryChange = (index, e) => {
    const { name, value } = e.target;
    setEntries((prev) =>
      prev.map((entry, i) => {
        if (i !== index) return entry;

        if (name === "name") {
          const selectedCust = customers.find((c) => c.name === value);
          // The party changed, so whatever was adjusted belongs to somebody
          // else's bills. Kept, it would be saved against invoices this party
          // never raised -- and the server would refuse the whole voucher.
          // A different party is a different adjustment, so the line may be
          // offered the picker again.
          offered.current.delete(index);
          return {
            ...entry,
            name: value,
            custId: selectedCust?._id || "",
            allocations: [],
          };
        }

        // Changing the amount does not clear the adjustment -- the server
        // refuses an over-allocation and the picker shows it in red first --
        // but the direction decides WHICH bills are eligible, so flipping a
        // debit to a credit does invalidate it.
        if (name === "debit" || name === "credit") {
          const next = { ...entry, [name]: value };
          const flipped = billTypeFor(next) !== billTypeFor(entry);
          return flipped ? { ...next, allocations: [] } : next;
        }

        return { ...entry, [name]: value };
      })
    );
  };

  /**
   * Sigfa brings the bill grid up when you leave a line, and the line is
   * what tells it which bills: a party and a direction. Waiting for a button
   * to be noticed is why ticking the box looked like it did nothing.
   *
   * Offered ONCE per line. A second pop after the user closed it would be a
   * trap, so the line is marked as soon as the picker opens and only
   * unmarked when its party changes -- a different party is a different
   * adjustment.
   */
  const offered = useRef(new Set());

  const leaveLine = (index) => (event) => {
    if (!form.againstBill) return;

    // Still inside the same line: tabbing from Debit to Credit is not
    // leaving it, and popping there would fire before the amount is typed.
    const row = event.currentTarget.closest("tr");
    if (row && event.relatedTarget && row.contains(event.relatedTarget)) return;

    const entry = entries[index];
    if (!entry?.name || !billTypeFor(entry)) return;
    if ((entry.allocations || []).length) return;
    if (adjusting !== null) return;
    if (offered.current.has(index)) return;

    offered.current.add(index);
    setAdjusting(index);
  };

  const addEntry = () => {
    setEntries((prev) => [
      ...prev,
      { name: "", debit: "", credit: "", custId: "", narration: "", allocations: [] },
    ]);
  };

  const removeEntry = (index) => {
    if (entries.length > 1) {
      setEntries((prev) => prev.filter((_, i) => i !== index));
    }
  };

  // --- submit ---
  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      const endpoint = voucherParams.value
        ? "/api/voucher-alter"
        : "/api/voucher-add";

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acName: form.acName,
          date: form.date,
          againstBill: form.againstBill,
          acType: form.acType,
          narration: form.narration, // 🔹 send main narration
          paymentType: voucherParams.type,
          customers: entries.map((entry) => ({
            name: entry.name,
            debit: parseFloat(entry.debit) || 0,
            credit: parseFloat(entry.credit) || 0,
            custId: entry.custId,
            narration: entry.narration, // 🔹 send customer narration
            allocations: entry.allocations || [],
          })),
          ...(voucherParams.value && { id: voucherParams.value }),
        }),
      });

      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server's own words. It names the bill and the figure -- "Failed
        // to save voucher" tells the user nothing they can act on.
        throw new Error(result.error || "Failed to save voucher");
      }

      alert(
        voucherParams.value
          ? "Voucher updated successfully!"
          : "Voucher added successfully!"
      );

      setForm({
        acName: "",
        date: new Date().toISOString().slice(0, 10),
        againstBill: false,
        acType: "",
        narration: "",
      });

      setEntries([{ name: "", debit: "", credit: "", custId: "", narration: "", allocations: [] }]);
      setVoucherParams({ type: "", value: "" });
    } catch (error) {
      alert(error.message);
    }
  };

  return (
    <>
      <Suspense fallback={null}>
        <VoucherSearchParams onParams={setVoucherParams} />
      </Suspense>

      <div className="page-shell">
        <div className="page-header items-start">
          <div>
            <h1 className="page-title">
              {voucherParams.type === "Cash" ? "Cash Voucher" : "Bank Voucher"}
            </h1>
            <p className="page-subtitle">Date: {form.date}</p>
          </div>
          <div className="space-y-1 text-right text-sm text-muted-foreground">
            <p>
              {voucherParams.type === "Cash" ? "Cash" : "Bank"} A/c:{" "}
              <span className="font-semibold">
                {form.acName || "Select Account"}
              </span>
            </p>
            <p>
              Type:{" "}
              <span className="font-semibold">{form.acType || "None"}</span>
            </p>
            <p>
              Against Bill:{" "}
              <span className="font-semibold">
                {form.againstBill ? "Yes" : "No"}
              </span>
            </p>
          </div>
        </div>

        {/* --- VOUCHER FORM --- */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Sigfa's "Against Bill", and it sits HERE, immediately above the
              lines it governs. It used to live below the table with the
              account fields, so ticking it changed something off-screen above
              and read as having done nothing at all. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                name="againstBill"
                checked={form.againstBill}
                onChange={handleFormChange}
                className="field-check"
              />
              <span className="whitespace-nowrap">Against Bill</span>
            </label>
            {form.againstBill && (
              <span className="field-hint">
                The bills come up as you leave each line. A line needs a party and
                an amount before there is anything to adjust.
              </span>
            )}
          </div>

          {/* Table */}
          <div className="table-wrap">
            <table className="data-table min-w-[760px]">
              <thead>
                <tr>
                  <th>Account Name</th>
                  <th>Narration</th> {/* 🔹 Added */}
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                  <th className="text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={index}>
                    <td>
                      <select
                        name="name"
                        value={entry.name}
                        onChange={(e) => handleEntryChange(index, e)}
                        className="w-full bg-transparent text-sm outline-none focus:ring-0"
                        required
                      >
                        <option value="" disabled>
                          Select Customer
                        </option>
                        {customers.map((cust, i) => (
                          <option key={i} value={cust.name}>
                            {cust.name}
                          </option>
                        ))}
                      </select>
                      {/* Where this party is and what they stand at, as the
                          same subtext the billing pages show under their
                          customer picker. */}
                      <PartyBalance
                        selected={{ name: entry.name, custId: entry.custId }}
                        customers={customers}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        name="narration"
                        value={entry.narration}
                        onChange={(e) => handleEntryChange(index, e)}
                        placeholder="Narration..."
                        className="w-full bg-transparent text-sm outline-none focus:ring-0"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        name="debit"
                        value={entry.debit}
                        onChange={(e) => handleEntryChange(index, e)}
                        onBlur={leaveLine(index)}
                        className="field-input field-input-sm num"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        name="credit"
                        value={entry.credit}
                        onChange={(e) => handleEntryChange(index, e)}
                        onBlur={leaveLine(index)}
                        className="field-input field-input-sm num"
                      />
                    </td>
                    <td className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        {/* Sigfa's "Against Bill", per line. Offered only
                            once the line can actually be adjusted: a party
                            and a direction are both needed to know which
                            bills are eligible. */}
                        {form.againstBill && (
                          <button
                            type="button"
                            onClick={() => setAdjusting(index)}
                            disabled={!entry.name || !billTypeFor(entry)}
                            className="btn btn-ghost btn-sm"
                            title={
                              !entry.name
                                ? "Pick a party first"
                                : !billTypeFor(entry)
                                  ? "Enter a debit or a credit first"
                                  : "Adjust against bills"
                            }
                          >
                            {(entry.allocations || []).length
                              ? `${entry.allocations.length} bill${entry.allocations.length === 1 ? "" : "s"}`
                              : "Adjust"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => removeEntry(index)}
                          className="btn btn-ghost btn-sm text-destructive hover:text-destructive"
                        >
                          Remove
                        </button>
                      </div>
                      {/* Always a word about this line while the box is
                          ticked. A greyed-out button on its own is what made
                          the feature look broken: nothing said what was
                          missing. */}
                      {form.againstBill && (
                        <span className="field-hint block">
                          {(entry.allocations || []).length > 0
                            ? `${allocatedTotal(entry.allocations).toFixed(2)} of ${lineAmount(entry).toFixed(2)} adjusted`
                            : !entry.name
                              ? "Pick a party"
                              : !billTypeFor(entry)
                                ? "Enter a debit or a credit"
                                : "Nothing adjusted yet"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>
                    <button
                      type="button"
                      onClick={addEntry}
                      className="btn btn-ghost btn-sm text-primary hover:text-primary"
                    >
                      + Add Customer Row
                    </button>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Account Details + Main Narration */}
          <div className="panel panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            <div>
              <label className="field-label">
                {voucherParams.type === "Cash" ? "Cash A/c" : "Bank A/c"}
              </label>
              <select
                name="acName"
                value={form.acName}
                onChange={handleFormChange}
                required
                className="field-select mt-1.5"
              >
                <option value="" disabled>
                  Select {voucherParams.type === "Cash" ? "Cash" : "Bank"} Account
                </option>
                {customers
                  .filter((cust) =>
                    voucherParams.type === "Cash"
                      ? cust.group?.toLowerCase() === "cash"
                      : cust.group?.toLowerCase() === "bank"
                  )
                  .map((cust, i) => (
                    <option key={i} value={cust.name}>
                      {cust.name}
                    </option>
                  ))}
              </select>
              {/* The cash drawer / bank account itself. Dr here is money held,
                  not money owed, which is why the wording is group-aware. */}
              <PartyBalance selected={{ name: form.acName }} customers={customers} />
            </div>

            <div>
              <label className="field-label">Account Type</label>
              <input
                type="text"
                name="acType"
                value={form.acType}
                onChange={handleFormChange}
                placeholder="e.g. Cash, Bank"
                className="field-input mt-1.5"
              />
            </div>

          </div>

          {/* 🔹 Main Narration Field */}
          <div>
            <label className="field-label">Main Narration</label>
            <textarea
              name="narration"
              value={form.narration}
              onChange={handleFormChange}
              rows={2}
              placeholder="Enter narration for main account..."
              className="field-input mt-1.5 h-auto py-2"
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full sm:w-auto"
          >
            {voucherParams.value ? "Update Voucher" : "Add Voucher"}
          </button>
        </form>

        {/* One picker, for whichever line asked for it. Mounted outside the
            table so the modal is not a descendant of a <td>. */}
        {adjusting !== null && entries[adjusting] && (
          <BillAdjust
            open
            line={entries[adjusting]}
            voucherId={voucherParams.value || ""}
            onClose={() => setAdjusting(null)}
            onApply={(allocations) =>
              setEntries((prev) =>
                prev.map((entry, i) => (i === adjusting ? { ...entry, allocations } : entry))
              )
            }
          />
        )}
      </div>
    </>
  );
};

export default AddVoucher;
