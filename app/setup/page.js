'use client'
import React, { useState } from 'react';
import Link from 'next/link';
import { useSaleOptions } from '@/context/SaleOptionContext';

const Page = () => {
  const { options, setOptions } = useSaleOptions();
   const [loadings, setLoadings] = useState(false);
  const [clearingTxns, setClearingTxns] = useState(false);

  const handleChange = (e) => {
    const { name, checked } = e.target;
    setOptions((prev) => ({
      ...prev,
      [name]: checked,
    }));
  };

  // The server refuses anything that does not carry the exact phrase, so the
  // prompt is not decoration -- a mistyped answer is rejected there too.
  //
  // The two phrases are deliberately different. Clearing the transactions is a
  // routine thing to do before going live; wiping the masters is not, and
  // muscle memory from typing one must not fire the other.
  const CONFIRM_PHRASE = "DELETE ALL DATA";
  const CLEAR_TXNS_PHRASE = "CLEAR TRANSACTIONS";

  const confirmAndClear = async ({ phrase, url, warning, setBusy }) => {
    const typed = window.prompt(`${warning}\n\nType ${phrase} to confirm.`);

    if (typed !== phrase) {
      if (typed !== null) alert("Phrase did not match. Nothing was deleted.");
      return;
    }

    try {
      setBusy(true);

      const res = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: phrase }),
      });

      const data = await res.json();

      alert(data.message);
    } catch (error) {
      alert("Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const handleClearTransactions = () =>
    confirmAndClear({
      phrase: CLEAR_TXNS_PHRASE,
      url: "/api/clear-transactions",
      warning:
        "This deletes every invoice, voucher and ledger entry, and resets each party to its opening balance.\n\nCustomers, items, HSN codes and price lists are kept. This cannot be undone.",
      setBusy: setClearingTxns,
    });

  const handleClearData = () =>
    confirmAndClear({
      phrase: CONFIRM_PHRASE,
      url: "/api/clear-all-data",
      warning:
        "This permanently deletes every item, customer, invoice, voucher and ledger entry.",
      setBusy: setLoadings,
    });

  const optionLabels = {
    description: 'Description for Products',
    shipped: 'Shipped To',
    dispatch: 'Dispatch From',
    calculateByPack: 'Enable Quantity = Per Pack × No. of Packs', 
     rollStationary: 'Use Roll Stationary Invoice Format',
    usePriceList: "Take Rates from Party's Price List",
  };

  return (
    <div className="page-shell max-w-2xl">
      <header className="page-header">
        <div>
          <h1 className="page-title">Setup</h1>
          <p className="page-subtitle">Choose which fields appear while billing.</p>
        </div>
      </header>

      {/* Listed first because it is the one thing here that has to be filled
          in before anything the app prints is a valid tax invoice. */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Business profile</h2>
        </div>
        <div className="panel-body flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-sm text-sm text-muted-foreground">
            Your firm's name, GSTIN, address and bank details — what prints on every
            invoice, ledger and report you issue.
          </p>
          <Link href="/company" className="btn btn-secondary">
            Edit profile
          </Link>
        </div>
      </section>

      <section className="panel mt-5">
        <div className="panel-head">
          <h2 className="panel-title">Invoice options</h2>
        </div>
        <div className="panel-body flex flex-col gap-2">
          {Object.keys(optionLabels).map((key) => (
            <label
              key={key}
              className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-accent/40"
            >
              <span className="text-sm font-medium text-foreground">{optionLabels[key]}</span>
              <input
                type="checkbox"
                name={key}
                checked={!!options[key]}
                onChange={handleChange}
                className="field-check"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="panel mt-5 border-destructive/30">
        <div className="panel-head border-destructive/30">
          <h2 className="panel-title text-destructive">Danger zone</h2>
        </div>
        {/* Clearing the books keeps the masters, which is what you want between
            a trial run and going live. Listed first because it is the one
            anybody actually needs. */}
        <div className="panel-body flex flex-wrap items-center justify-between gap-4 border-b border-destructive/20">
          <p className="max-w-sm text-sm text-muted-foreground">
            Deletes every invoice, voucher and ledger entry, and resets each party to
            its opening balance. Customers, items, HSN codes and price lists are kept.
            This cannot be undone.
          </p>
          <button
            onClick={handleClearTransactions}
            disabled={clearingTxns || loadings}
            className="btn btn-danger"
          >
            {clearingTxns ? "Clearing..." : "Clear Transactions"}
          </button>
        </div>

        <div className="panel-body flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-sm text-sm text-muted-foreground">
            Permanently deletes every item, customer, invoice and HSN record. This cannot be undone.
          </p>
          <button
            onClick={handleClearData}
            disabled={loadings || clearingTxns}
            className="btn btn-danger"
          >
            {loadings ? "Deleting..." : "Clear All Data"}
          </button>
        </div>
      </section>
    </div>
  );
};

export default Page;
