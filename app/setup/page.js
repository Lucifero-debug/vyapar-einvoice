'use client'
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSaleOptions } from '@/context/SaleOptionContext';
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';
import SeriesMaster from '@/components/SeriesMaster';
import { docTypeLabel } from '@/lib/series.mjs';

const Page = () => {
  const { options, setOptions } = useSaleOptions();
   const [loadings, setLoadings] = useState(false);
  const [clearingTxns, setClearingTxns] = useState(false);
  const [notice, notify] = useNotice();

  // The series master -- Sigfa's SubKey, which it keeps under Setup, so this
  // is where it lives here too. The dashboard's Masters panel has the same
  // records behind its own Create / Alter / Delete row.
  const [series, setSeries] = useState([]);
  const [loadingSeries, setLoadingSeries] = useState(true);
  const [editingSeries, setEditingSeries] = useState(null);
  const [seriesOpen, setSeriesOpen] = useState(false);

  const loadSeries = useCallback(async () => {
    setLoadingSeries(true);
    try {
      const res = await fetch('/api/get-series');
      const data = await res.json();
      if (data.success) setSeries(data.series || []);
    } catch (error) {
      console.error('Could not load the series master:', error);
    } finally {
      setLoadingSeries(false);
    }
  }, []);

  useEffect(() => {
    loadSeries();
  }, [loadSeries]);

  /**
   * Delete a series, which the route refuses while any slip carries it.
   *
   * The refusal is shown as it arrives: it counts the slips, which is the part
   * worth reading. Retiring a series without deleting it is what Active is
   * for, and the message says so.
   */
  const removeSeries = async (record) => {
    const code = record?.code || 'this series';
    if (!window.confirm(`Delete series ${code}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/delete-series?id=${encodeURIComponent(record._id)}`, {
        method: 'POST',
      });
      const { ok, message } = await readResponse(res);
      if (ok) {
        notify.success(`Series ${code} deleted.`);
        loadSeries();
      } else {
        notify.error(`Not deleted. ${message}`);
      }
    } catch (error) {
      console.error('Delete series error:', error);
      notify.error(`Not deleted. ${NETWORK_ERROR}`);
    }
  };

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
      if (typed !== null) notify.error("The phrase did not match. Nothing was deleted.");
      return;
    }

    try {
      setBusy(true);

      const res = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: phrase }),
      });

      // Success and refusal both used to come up as alert(data.message) --
      // a refusal that sent `error` instead showed "undefined".
      const { ok, body: data, message } = await readResponse(res);
      if (ok) notify.success(data.message || "Done.");
      else notify.error(`Nothing was deleted. ${message}`);
    } catch (error) {
      console.error("Clear data error:", error);
      notify.error(`The request did not complete. ${NETWORK_ERROR} Reload the page to see what is left before trying again.`);
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
      <Notice notice={notice} onClose={notify.clear} />

      {/* Listed first because it is the one thing here that has to be filled
          in before anything the app prints is a valid tax invoice. */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Business profile</h2>
        </div>
        <div className="panel-body flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-sm text-sm text-muted-foreground">
            Your firm&apos;s name, GSTIN, address and bank details — what prints on every
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

      {/* Sigfa keeps its SubKey master under Setup, so this is where it is
          here. The slip screens offer what is listed below, and Alt+A adds one
          without leaving a half-filled slip. */}
      <section className="panel mt-5">
        <div className="panel-head flex flex-wrap items-center justify-between gap-3">
          <h2 className="panel-title">Document series</h2>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setEditingSeries(null);
              setSeriesOpen(true);
            }}
          >
            Add series
          </button>
        </div>
        <div className="panel-body">
          <p className="mb-3 max-w-prose text-sm text-muted-foreground">
            Sigfa&apos;s Series Master: a series per document — sales and purchase
            invoices, challans, returns, orders, production and the goods slips — with
            its print profile, headings and declaration. It labels a document and groups
            it on the register; it does not number one, so choosing a series can never
            put a gap in a sequence.
          </p>

          {loadingSeries ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : series.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No series yet. Nothing has to be entered here before you can raise a
              document — the Series box appears once a series exists for that kind,
              and a slip still offers anything your slips already carry.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3">Series</th>
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Document</th>
                    <th className="py-2 pr-3">Default</th>
                    <th className="py-2 pr-3">Active</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {series.map((record) => (
                    <tr key={record._id} className="border-b border-border/60">
                      <td className="py-2 pr-3 font-medium text-foreground">{record.code}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{record.name || '—'}</td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {docTypeLabel(record.docType) || '—'}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {record.isDefault ? 'Yes' : '—'}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {record.active === false ? 'No' : 'Yes'}
                      </td>
                      <td className="py-2">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              setEditingSeries(record);
                              setSeriesOpen(true);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => removeSeries(record)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {seriesOpen && (
        <SeriesMaster
          open={seriesOpen}
          selected={editingSeries}
          onClose={(saved) => {
            setSeriesOpen(false);
            setEditingSeries(null);
            // Reloaded rather than reloading the page, so the invoice options
            // above keep whatever was just ticked.
            if (saved === true) loadSeries();
          }}
        />
      )}

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
