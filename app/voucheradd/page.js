"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import VoucherSearchParams from "@/components/VoucherSearchparams";
import PartyBalance from "@/components/PartyBalance";
import BillAdjust from "@/components/BillAdjust";
import { allocatedTotal, billTypeFor, lineAmount } from "@/lib/billAdjust.mjs";
import {
  VOUCHER_KINDS,
  VOUCHER_KIND_CODES,
  isVoucherKind,
  kindOf,
  lineTotals,
  voucherProblems,
  voucherTitle,
} from "@/lib/voucherKinds.mjs";
import { istToday } from "@/lib/istDate.mjs";
import { Notice, useNotice } from "@/components/ui/notice";
import { NETWORK_ERROR, readResponse } from "@/lib/apiResponse.mjs";

/** Today in India, not in UTC -- see istToday in lib/istDate.mjs. */
const todayIst = () => istToday();

/**
 * The parties filed under one of these groups.
 *
 * A contra moves money between our OWN accounts, so its line may only name
 * cash or bank -- offering the whole party list would let somebody book a
 * transfer to a customer, which is a payment wearing a contra's name.
 */
const customersInGroups = (customers = [], groups = []) =>
  customers.filter((c) => groups.includes(String(c?.group || "").toLowerCase()));

const AddVoucher = () => {
  const [voucherParams, setVoucherParams] = useState({ type: "", value: "", kind: "" });

  /*
    Which of the four this is -- lib/voucherKinds.mjs.

    Receipt and Payment name the direction the money went, which the old
    Cash/Bank pair never did: that said which ACCOUNT it moved through, and
    which way was decided only by the column somebody typed into. Journal has
    no cash leg at all, and Contra moves money between two of our own
    accounts.
  */
  const [kind, setKind] = useState("RECEIPT");

  /*
    Cash or bank -- the instrument, which is a separate question from the
    direction. It used to arrive only in the URL, so opening /voucheradd
    without one left it blank and the save was refused with nothing on screen
    to set it with.
  */
  const [instrument, setInstrument] = useState("Cash");

  const [form, setForm] = useState({
    acName: "",
    date: todayIst(),
    againstBill: false,
    acType: "",
    narration: "", // 🔹 Added main narration
  });
  const [notice, notify] = useNotice();
  const [saving, setSaving] = useState(false);

  const [entries, setEntries] = useState([
    { name: "", debit: "", credit: "", custId: "", narration: "", allocations: [] },
  ]);

  const [customers, setCustomers] = useState([]);

  // Which line's bill picker is open, by index. Sigfa's "Against Bill" is a
  // per-line thing: one voucher can settle two parties' bills at once.
  const [adjusting, setAdjusting] = useState(null);

  const spec = VOUCHER_KINDS[kind] ?? VOUCHER_KINDS.RECEIPT;

  /** The accounts a line may name: our own cash and bank for a contra. */
  const lineAccounts = spec.ownAccounts
    ? customersInGroups(customers, ["cash", "bank"])
    : customers;

  /** What the lines come to, for the journal's own balance check. */
  const totals = lineTotals(
    entries.map((e) => ({ debit: parseFloat(e.debit) || 0, credit: parseFloat(e.credit) || 0 }))
  );
  const outBy = Math.round((totals.debit - totals.credit) * 100) / 100;

  /**
   * Changing the kind moves the figures rather than dropping them.
   *
   * Switching Receipt to Payment means the same amounts going the other way,
   * so a figure in the column the new kind forbids is carried across instead
   * of being left somewhere the save would refuse. The ADJUSTMENTS do go:
   * the direction decides which bills are eligible, which is the same reason
   * handleEntryChange clears them when a side is flipped.
   */
  const changeKind = (next) => {
    if (!isVoucherKind(next)) return;
    const to = VOUCHER_KINDS[next];
    setKind(next);

    setEntries((prev) => {
      const moved = prev.map((entry) => {
        const amount = parseFloat(entry.debit) || parseFloat(entry.credit) || "";
        if (!to.side) return { ...entry, allocations: [] };
        return {
          ...entry,
          debit: to.side === "debit" ? String(amount || "") : "",
          credit: to.side === "credit" ? String(amount || "") : "",
          allocations: [],
        };
      });
      // A contra is one line: cash out of here, into there.
      return to.code === "CONTRA" ? moved.slice(0, 1) : moved;
    });

    // A journal has no cash leg, so holding one would have the save refuse
    // it -- and a bill adjustment needs a party with bills, which neither a
    // journal nor a contra has.
    setForm((prev) => ({
      ...prev,
      acName: to.needsAccount ? prev.acName : "",
      acType: to.needsAccount ? prev.acType : "",
      againstBill: to.needsAccount && !to.ownAccounts ? prev.againstBill : false,
    }));
  };

  // --- existing fetch logic unchanged ---
  useEffect(() => {
    const fetchCust = async () => {
      try {
        const response = await fetch("/api/get-customer");
        const result = await response.json();
        setCustomers(result.customer || []);
      } catch (error) {
        console.error("Error fetching customer data:", error);
        notify.error("Could not load the party list. Reload the page to try again.");
      }
    };

    fetchCust();
  }, []);

  /*
    The kind and the instrument a deep link asked for -- so the dashboard can
    open a Payment or a Journal directly.

    Only for a NEW voucher. An existing one takes both from what was stored
    (or, with no stored kind, from its own figures), and a stray ?kind= in the
    URL must not quietly re-post it as something else.
  */
  useEffect(() => {
    if (voucherParams.value) return;
    if (isVoucherKind(voucherParams.kind)) setKind(voucherParams.kind);
    if (voucherParams.type === "Cash" || voucherParams.type === "Bank") {
      setInstrument(voucherParams.type);
    }
  }, [voucherParams.kind, voucherParams.type, voucherParams.value]);

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

          // Its own kind, or -- for an entry saved before the four existed --
          // the one read off its figures. Nothing is rewritten: the reading
          // only decides what the form shows and what the next save stores.
          setKind(kindOf(voucher).code);
          if (voucher.paymentType) setInstrument(voucher.paymentType);

          setForm({
            acName: voucher.acName || "",
            date:
              voucher.date?.slice(0, 10) ||
              todayIst(),
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
          notify.error("Could not load this voucher. Reload the page to try again.");
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
    // One save at a time: a double click posted the voucher twice.
    if (saving) return;
    setSaving(true);
    notify.clear();

    try {
      const endpoint = voucherParams.value
        ? "/api/voucher-alter"
        : "/api/voucher-add";

      const lines = entries.map((entry) => ({
        name: entry.name,
        debit: parseFloat(entry.debit) || 0,
        credit: parseFloat(entry.credit) || 0,
        custId: entry.custId,
        narration: entry.narration, // 🔹 send customer narration
        allocations: entry.allocations || [],
      }));

      // Blank for a journal, whatever is left in state or in the URL: the
      // kind decides whether there is an account at all, and sending one
      // would have the route refuse the voucher.
      const acName = spec.needsAccount ? form.acName : "";
      const paymentType = spec.needsAccount ? instrument : "";

      // The same rules the routes apply, run here first so a refusal is a
      // message beside the form rather than a round trip. The routes' copy
      // is the one that counts -- lib/voucherKinds.mjs owns both.
      const problems = voucherProblems({ kind, acName, paymentType, customers: lines });
      if (problems.length) {
        notify.error(problems[0]);
        return;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          acName,
          date: form.date,
          againstBill: form.againstBill,
          acType: form.acType,
          narration: form.narration, // 🔹 send main narration
          paymentType,
          customers: lines,
          ...(voucherParams.value && { id: voucherParams.value }),
        }),
      });

      // The server's own words. It names the bill and the figure -- "Failed
      // to save voucher" tells the user nothing they can act on.
      const { ok, message } = await readResponse(res);
      if (!ok) {
        notify.error(`The voucher was not saved. ${message}`);
        return;
      }

      notify.success(voucherParams.value ? "Voucher updated." : "Voucher added.");

      setForm({
        acName: "",
        date: todayIst(),
        againstBill: false,
        acType: "",
        narration: "",
      });

      setEntries([{ name: "", debit: "", credit: "", custId: "", narration: "", allocations: [] }]);
      // The KIND and the instrument are deliberately kept: receipts are
      // entered in a run, and resetting to Receipt-Cash after every save
      // would have somebody re-pick them for each of twenty payments.
      setVoucherParams((prev) => ({ ...prev, value: "" }));
    } catch (error) {
      console.error("Voucher save error:", error);
      notify.error(`The voucher was not saved. ${NETWORK_ERROR}`);
    } finally {
      setSaving(false);
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
            <h1 className="page-title">{voucherTitle(kind)}</h1>
            <p className="page-subtitle">
              {spec.blurb} Date: {form.date}
            </p>
          </div>
          <div className="space-y-1 text-right text-sm text-muted-foreground">
            {spec.needsAccount && (
              <p>
                {spec.code === "CONTRA" ? "Into" : `${instrument} A/c`}:{" "}
                <span className="font-semibold">
                  {form.acName || "Select Account"}
                </span>
              </p>
            )}
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

        {/* The four kinds. Receipt and Payment are the same screen read the
            other way round; Journal drops the cash leg entirely; Contra is
            one line between two of our own accounts. Cash-or-bank is a
            separate question -- it says which account, not which way. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {VOUCHER_KIND_CODES.map((code) => (
            <button
              key={code}
              type="button"
              className={`btn btn-sm ${kind === code ? "btn-primary" : "btn-secondary"}`}
              aria-pressed={kind === code}
              onClick={() => changeKind(code)}
            >
              {VOUCHER_KINDS[code].label}
            </button>
          ))}

          {spec.needsAccount && (
            <>
              <span className="mx-1 h-5 w-px bg-border" />
              {["Cash", "Bank"].map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`btn btn-sm ${instrument === option ? "btn-primary" : "btn-ghost"}`}
                  aria-pressed={instrument === option}
                  onClick={() => {
                    setInstrument(option);
                    // The account picker is filtered by this, so whatever was
                    // chosen is from the other group and is no longer offered.
                    setForm((prev) => ({ ...prev, acName: "" }));
                  }}
                >
                  {option}
                </button>
              ))}
            </>
          )}
        </div>

        <Notice notice={notice} onClose={notify.clear} />

        {/* --- VOUCHER FORM --- */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Sigfa's "Against Bill", and it sits HERE, immediately above the
              lines it governs. It used to live below the table with the
              account fields, so ticking it changed something off-screen above
              and read as having done nothing at all. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Only a receipt or a payment has bills to settle. A journal
                moves no money and a contra moves it between our own
                accounts, so neither has an invoice to adjust against. */}
            <label
              className={`flex items-center gap-2 text-sm font-medium text-foreground ${
                spec.needsAccount && !spec.ownAccounts ? "cursor-pointer" : "opacity-50"
              }`}
            >
              <input
                type="checkbox"
                name="againstBill"
                checked={form.againstBill}
                onChange={handleFormChange}
                disabled={!spec.needsAccount || spec.ownAccounts}
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
                  {/* Named by the kind: "Received from" on a receipt, "Paid
                      to" on a payment, "Moved from" on a contra. The column
                      said "Account Name" whichever way the money went. */}
                  <th>{spec.lineLabel}</th>
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
                          {spec.ownAccounts ? "Select Cash or Bank A/c" : "Select Customer"}
                        </option>
                        {lineAccounts.map((cust, i) => (
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
                      {/* The direction is the kind's, not a column the
                          operator picks. A receipt credits the party and a
                          payment debits it; only a journal is free to use
                          either side, line by line. */}
                      <input
                        type="number"
                        name="debit"
                        value={entry.debit}
                        onChange={(e) => handleEntryChange(index, e)}
                        onBlur={leaveLine(index)}
                        disabled={spec.side === "credit"}
                        title={spec.side === "credit" ? `A ${spec.label.toLowerCase()} is a credit` : undefined}
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
                        disabled={spec.side === "debit"}
                        title={spec.side === "debit" ? `A ${spec.label.toLowerCase()} is a debit` : undefined}
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
                {/* The running total, and what a journal is out by.

                    A journal has no account to absorb the difference, so its
                    own lines have to balance -- and the figure belongs on
                    screen while it is being typed, not only in the refusal
                    afterwards. */}
                <tr>
                  <td colSpan={2} className="text-right font-medium">
                    Total
                  </td>
                  <td className="num font-medium">{totals.debit.toFixed(2)}</td>
                  <td className="num font-medium">{totals.credit.toFixed(2)}</td>
                  <td className="text-center">
                    {spec.mustBalance &&
                      (outBy === 0 ? (
                        <span className="field-hint">balanced</span>
                      ) : (
                        <span className="text-xs font-medium text-destructive">
                          out by {Math.abs(outBy).toFixed(2)}
                        </span>
                      ))}
                  </td>
                </tr>
                {/* A contra is one line by definition: out of one account,
                    into another. */}
                {spec.code !== "CONTRA" && (
                  <tr>
                    <td colSpan={5}>
                      <button
                        type="button"
                        onClick={addEntry}
                        className="btn btn-ghost btn-sm text-primary hover:text-primary"
                      >
                        + Add Row
                      </button>
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>

          {/* The account the money moved through. A journal moved none, so it
              has no such account and the whole panel goes -- holding one
              would post a cash leg for an adjustment that never touched
              cash, and the save refuses it. */}
          {spec.needsAccount && (
            <div className="panel panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
              <div>
                <label className="field-label">
                  {spec.code === "CONTRA" ? `Moved into (${instrument})` : `${instrument} A/c`}
                </label>
                <select
                  name="acName"
                  value={form.acName}
                  onChange={handleFormChange}
                  required
                  className="field-select mt-1.5"
                >
                  <option value="" disabled>
                    Select {instrument} Account
                  </option>
                  {customersInGroups(customers, [instrument.toLowerCase()]).map((cust, i) => (
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
          )}

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
            disabled={saving}
            aria-busy={saving}
          >
            {saving ? "Saving…" : voucherParams.value ? "Update Voucher" : "Add Voucher"}
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
