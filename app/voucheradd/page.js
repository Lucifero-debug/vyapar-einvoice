"use client";

import React, { Suspense, useEffect, useState } from "react";
import VoucherSearchParams from "@/components/VoucherSearchparams";
import PartyBalance from "@/components/PartyBalance";

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
    { name: "", debit: "", credit: "", custId: "", narration: "" }, // 🔹 Added narration
  ]);

  const [customers, setCustomers] = useState([]);

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
              };
            }) || [{ name: "", debit: "", credit: "", custId: "", narration: "" }]
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
          return {
            ...entry,
            name: value,
            custId: selectedCust?._id || "",
          };
        }

        return { ...entry, [name]: value };
      })
    );
  };

  const addEntry = () => {
    setEntries((prev) => [
      ...prev,
      { name: "", debit: "", credit: "", custId: "", narration: "" },
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
          })),
          ...(voucherParams.value && { id: voucherParams.value }),
        }),
      });

      if (!res.ok) throw new Error("Failed to save voucher");

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

      setEntries([{ name: "", debit: "", credit: "", custId: "", narration: "" }]);
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
                        className="field-input field-input-sm num"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        name="credit"
                        value={entry.credit}
                        onChange={(e) => handleEntryChange(index, e)}
                        className="field-input field-input-sm num"
                      />
                    </td>
                    <td className="text-center">
                      <button
                        type="button"
                        onClick={() => removeEntry(index)}
                        className="btn btn-ghost btn-sm text-destructive hover:text-destructive"
                      >
                        Remove
                      </button>
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

            <label className="mt-6 flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                name="againstBill"
                checked={form.againstBill}
                onChange={handleFormChange}
                className="field-check"
              />
              Against Bill
            </label>
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
      </div>
    </>
  );
};

export default AddVoucher;
