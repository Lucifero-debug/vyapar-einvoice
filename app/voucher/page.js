'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useCompany } from '@/context/CompanyContext';
import { ledgerRowType } from '@/lib/ledgerTypes.mjs';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const formatAmount = (n = 0) => round2(n).toFixed(2);

/**
 * Voucher register — a day book of what was actually posted.
 *
 * This used to rebuild the entries in the browser from invoice documents: its
 * own second implementation of the posting rules, which disagreed with the
 * real one. It labelled every entry "BY LOCAL SALES" / "TO <customer>"
 * regardless of `invoice.type`, so purchases and returns were printed as
 * sales, and it ignored `received` entirely.
 *
 * It now reads the ledger rows the server wrote, so whatever the books say is
 * what this shows.
 */
export default function VoucherPage() {
  // The firm whose documents these are -- never a hardcoded one.
  const { company } = useCompany();
  const [ledgers, setLedgers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/ledger?customerId=0');
        if (!res.ok) throw new Error('Failed to load the ledger.');
        const data = await res.json();
        setLedgers(data.ledgers || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const entries = useMemo(() => {
    // One journal entry per source document.
    const groups = new Map();

    for (const row of ledgers) {
      const key = row.voucherId || `row:${row._id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const built = [];

    for (const [key, rows] of groups) {
      const lines = rows.map((r) => ({
        name: r.customerName,
        account: r.account,
        narration: r.narration,
        debit: round2(r.debit),
        credit: round2(r.credit),
      }));

      let debit = round2(lines.reduce((s, l) => s + l.debit, 0));
      let credit = round2(lines.reduce((s, l) => s + l.credit, 0));

      // The ledger is party-centric: a sale stores the customer's side but not
      // the nominal account facing it. Show that side rather than printing an
      // entry that visibly fails to balance. Vouchers already carry both sides,
      // so nothing is added there.
      const imbalance = round2(debit - credit);
      if (imbalance !== 0) {
        lines.push({
          name: rows[0].account || 'Suspense',
          account: rows[0].customerName,
          narration: rows[0].narration,
          debit: imbalance < 0 ? Math.abs(imbalance) : 0,
          credit: imbalance > 0 ? imbalance : 0,
          derived: true,
        });
        debit = round2(debit + (imbalance < 0 ? Math.abs(imbalance) : 0));
        credit = round2(credit + (imbalance > 0 ? imbalance : 0));
      }

      built.push({
        key,
        date: rows[0].date,
        narration: rows[0].narration || '',
        /*
          What raised this entry -- a receipt, a payment, a sales invoice, a
          purchase return (lib/ledgerTypes.mjs).

          This used to read `voucherKind` alone, and said so: blank for an
          invoice, because "a day book should say nothing rather than
          guess". That was right at the time -- an invoice's rows carried
          nothing to name them. They now carry `docType`, stamped when they
          are written, so naming an invoice entry is no longer a guess and
          the register can finally say which kind of bill it was looking at.

          For rows written before that field existed it IS still a reading,
          and `inferred` says so rather than letting a day book present a
          deduction as a record.

          Taken from the first row that yields one rather than from rows[0]:
          a GL contra row sorting first would otherwise leave a whole
          invoice unnamed.
        */
        type:
          rows.map(ledgerRowType).find((t) => t.short) ||
          { short: '', label: '', inferred: false },
        lines,
        debit,
        credit,
      });
    }

    return built.sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [ledgers]);

  const grandDebit = round2(entries.reduce((s, e) => s + e.debit, 0));
  const grandCredit = round2(entries.reduce((s, e) => s + e.credit, 0));

  return (
    <div className="page-shell report-sheet">
      <div className="doc-head">
        <h2 className="doc-org">{company.name}</h2>
        <p className="doc-meta">Every posting, in the order it was made</p>
        <p className="doc-kind">Voucher Register</p>
      </div>

      {loading ? (
        <div className="empty-state">Loading vouchers...</div>
      ) : error ? (
        <div className="empty-state text-destructive">{error}</div>
      ) : entries.length === 0 ? (
        <div className="empty-state">Nothing has been posted yet.</div>
      ) : (
        <>
          {entries.map((entry) => (
            <div
              key={entry.key}
              className="mb-5 overflow-hidden rounded-xl border border-border bg-card shadow-sm"
            >
              <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/60 px-4 py-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {entry.date
                    ? new Date(entry.date).toLocaleDateString('en-IN')
                    : '—'}
                  {/* Receipt, Payment, Sales Invoice -- which the figures
                      alone do not say to somebody reading a day book. The
                      full name, not the ledger's two letters: there is room
                      for it here. */}
                  {entry.type.label && (
                    <span
                      className="chip"
                      title={
                        entry.type.inferred
                          ? `${entry.type.label} (read from the entry)`
                          : entry.type.label
                      }
                    >
                      {entry.type.label}
                      {entry.type.inferred && (
                        <span className="ml-1 opacity-60" aria-hidden="true">?</span>
                      )}
                    </span>
                  )}
                </h3>
                <span className="chip">{entry.narration}</span>
              </div>

              <div className="overflow-x-auto">
                <table className="data-table report-table table-fixed min-w-[560px]">
                  <thead>
                    <tr>
                      <th className="w-[40%]">ACCOUNT</th>
                      <th className="w-[30%]">PARTICULARS</th>
                      <th className="w-[15%] text-right">DEBIT</th>
                      <th className="w-[15%] text-right">CREDIT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.lines.map((line, i) => (
                      <tr key={i} className={line.derived ? 'italic' : ''}>
                        <td className="font-medium">
                          {line.debit ? 'Dr' : 'Cr'} {line.name}
                        </td>
                        <td className="text-muted-foreground">{line.account}</td>
                        <td className="money-dr">
                          {line.debit ? formatAmount(line.debit) : ''}
                        </td>
                        <td className="money-cr">
                          {line.credit ? formatAmount(line.credit) : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="2" className="num">
                        TOTAL
                      </td>
                      <td className="num">{formatAmount(entry.debit)}</td>
                      <td className="num">{formatAmount(entry.credit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ))}

          <div className="overflow-x-auto rounded-xl border border-primary/30 bg-accent/50">
            <table className="data-table report-table table-fixed min-w-[560px]">
              <tfoot>
                <tr>
                  <td colSpan="2" className="num text-base">
                    GRAND TOTAL
                  </td>
                  <td className="num w-[15%] text-base">{formatAmount(grandDebit)}</td>
                  <td className="num w-[15%] text-base">{formatAmount(grandCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
