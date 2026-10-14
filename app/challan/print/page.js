'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import ChallanSearchParams from '@/components/ChallanSearchParams';
import { CompanyBrand, CompanyLogo } from '@/components/CompanyBrand';
import { useCompany } from '@/context/CompanyContext';
import { prefsFrom } from '@/lib/invoicePrefs.mjs';
import { CHALLAN_KINDS, CHALLAN_TYPES, challanTotals, priceLine } from '@/lib/challanStatus.mjs';
import { trim } from '@/lib/orderStatus.mjs';
import { splitGst } from '@/lib/gst.mjs';
import { MRI_LABEL, mriTotals, rejectedQty } from '@/lib/mri.mjs';

export const dynamic = 'force-dynamic';

/**
 * A challan on paper, titled as SIGFA titles it -- "SALES CHALLAN" /
 * "PURCHASE CHALLAN", "CHALLAN NO." -- with the goods' value and GST, which a
 * delivery challan carries (rule 55), and a line saying it is not a tax
 * invoice.
 */

const money = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '');

function ChallanPrint() {
  const { company } = useCompany();
  const prefs = prefsFrom(company);
  const [query, setQuery] = useState(null);
  const [challan, setChallan] = useState(null);
  const [error, setError] = useState('');

  const readParams = useCallback((q) => setQuery(q), []);

  useEffect(() => {
    if (!query) return;
    if (!CHALLAN_TYPES.includes(query.type) || !query.challanNo) {
      setError('Which challan? The link is missing its type or number.');
      return;
    }
    let live = true;
    fetch(`/api/get-challan?type=${encodeURIComponent(query.type)}&challanNo=${encodeURIComponent(query.challanNo)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (!d.success) setError(d.error || 'Challan not found.');
        else setChallan(d.challan);
      })
      .catch(() => live && setError('Could not reach the server.'));
    return () => {
      live = false;
    };
  }, [query]);

  const totals = useMemo(() => challanTotals(challan?.items || []), [challan]);
  const inter = challan && company?.stateCode && challan.stateCode && company.stateCode !== challan.stateCode;
  const { sgst, cgst } = splitGst(totals.gst);

  // The query string is read in its own Suspense (useSearchParams), and it
  // must be mounted in every branch -- including the loading one, or the
  // number is never read and the page loads forever.
  const params = (
    <Suspense fallback={null}>
      <ChallanSearchParams onValue={readParams} />
    </Suspense>
  );

  if (error) return <div className="p-6 text-sm text-destructive">{params}{error}</div>;
  if (!challan) return <div className="p-6 text-sm text-muted-foreground">{params}Loading…</div>;

  const kind = CHALLAN_KINDS[challan.type];
  const party = challan.customer || {};

  return (
    <div className="mx-auto max-w-3xl p-4">
      {params}
      <div className="no-print mb-4 flex justify-end">
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          Print
        </button>
      </div>

      <div className="invoice-doc rounded-xl border border-gray-300 bg-white p-6 text-[13px] text-gray-900">
        <header className="mb-4 flex items-start justify-between gap-4">
          <CompanyBrand company={company} prefs={prefs} size="invoice" />
          <CompanyLogo company={company} prefs={prefs} variant="screen" />
        </header>

        <h1 className="mb-4 border-y border-gray-300 py-2 text-center text-lg font-bold tracking-wide">{kind.printTitle}</h1>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold uppercase text-gray-600">
              {challan.type === 'Sale' ? 'Consignee' : 'Received from'}
            </p>
            <p className="font-semibold">{party.name}</p>
            {party.address && <p>{party.address}</p>}
            {(party.city || party.state) && <p>{[party.city, party.state, party.pincode].filter(Boolean).join(', ')}</p>}
            {party.gstin && <p>GSTIN: {party.gstin}</p>}
            {challan.shippedTo && <p className="mt-1">Shipped to: {challan.shippedTo}</p>}
          </div>
          <div className="text-right">
            <p>
              <span className="font-semibold">CHALLAN NO.</span> {challan.challanNo}
            </p>
            <p>
              <span className="font-semibold">Challan Date</span> {asDate(challan.date)}
            </p>
            {challan.partyChallanNo && (
              <p>
                Supplier&apos;s challan {challan.partyChallanNo}
                {challan.partyChallanDate ? ` dt. ${asDate(challan.partyChallanDate)}` : ''}
              </p>
            )}
            {challan.stateOfSupply && <p>Place of supply: {challan.stateOfSupply}</p>}
            {challan.mriNo ? (
              <p>
                <span className="font-semibold">{MRI_LABEL} No.</span> {challan.mriNo}
                {challan.againstMriNo ? ` (Re-MRI of ${challan.againstMriNo})` : ''}
              </p>
            ) : null}
          </div>
        </div>

        <table className="mb-4 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-y border-gray-400 text-left">
              <th className="py-1">#</th>
              <th className="py-1">Item</th>
              <th className="py-1">HSN</th>
              <th className="py-1 text-right">Qty</th>
              <th className="py-1 text-right">Rate</th>
              <th className="py-1 text-right">Disc %</th>
              <th className="py-1 text-right">GST %</th>
              <th className="py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(challan.items || []).map((l, i) => (
              <tr key={String(l._id)} className="border-b border-gray-200">
                <td className="py-1">{i + 1}</td>
                <td className="py-1">
                  {l.name}
                  {l.description ? <div className="text-[11px] text-gray-600">{l.description}</div> : null}
                </td>
                <td className="py-1">{l.hsn}</td>
                <td className="py-1 text-right">
                  {trim(l.quantity)} {l.uqc || ''}
                </td>
                <td className="py-1 text-right">{money(l.cost)}</td>
                <td className="py-1 text-right">{Number(l.discount) || 0}</td>
                <td className="py-1 text-right">{Number(l.gstRate) || 0}</td>
                <td className="py-1 text-right">{money(priceLine(l).taxableAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mb-4 ml-auto w-64 text-[12px]">
          <div className="flex justify-between">
            <span>Taxable value</span>
            <span>{money(totals.taxable)}</span>
          </div>
          {inter ? (
            <div className="flex justify-between">
              <span>IGST</span>
              <span>{money(totals.gst)}</span>
            </div>
          ) : (
            <>
              <div className="flex justify-between">
                <span>CGST</span>
                <span>{money(cgst)}</span>
              </div>
              <div className="flex justify-between">
                <span>SGST</span>
                <span>{money(sgst)}</span>
              </div>
            </>
          )}
          <div className="mt-1 flex justify-between border-t border-gray-400 pt-1 font-semibold">
            <span>Value of goods</span>
            <span>{money(totals.total)}</span>
          </div>
        </div>

        {(challan.transport || challan.vehicleNo || challan.grNo || challan.ewayBillNo) && (
          <div className="mb-4 grid grid-cols-2 gap-2 rounded-md border border-gray-300 bg-gray-50 p-3 text-[12px]">
            {challan.transport && <div>Transport: {challan.transport}</div>}
            {challan.vehicleNo && <div>Vehicle No.: {challan.vehicleNo}</div>}
            {challan.grNo && (
              <div>
                GR / LR No.: {challan.grNo}
                {challan.grDate ? ` dt. ${asDate(challan.grDate)}` : ''}
              </div>
            )}
            {challan.ewayBillNo && (
              <div>
                E-way bill: {challan.ewayBillNo}
                {challan.ewayBillDate ? ` dt. ${asDate(challan.ewayBillDate)}` : ''}
              </div>
            )}
          </div>
        )}

        {challan.mriNo ? (
          <div className="mb-4 rounded-md border border-gray-300 p-3 text-[12px]">
            {(() => {
              const t = mriTotals(challan.items);
              return (
                <p>
                  Received {trim(t.received)} · Accepted {trim(t.accepted)}
                  {t.rejected > 0 ? ` · Rejected ${trim(t.rejected)}` : ''} (quantities above are the accepted ones)
                </p>
              );
            })()}
            {(challan.items || [])
              .filter((l) => rejectedQty(l) > 0)
              .map((l) => (
                <p key={String(l._id)}>
                  Rejected — {l.name}: {trim(rejectedQty(l))}
                </p>
              ))}
            {challan.mriRemark && <p>Remark: {challan.mriRemark}</p>}
          </div>
        ) : null}

        {challan.remarks && <p className="mb-4 text-[12px]">Remarks: {challan.remarks}</p>}

        <p className="mb-8 text-[11px] text-gray-600">
          This is a delivery challan, not a tax invoice. The invoice for these goods is issued separately.
        </p>

        <div className="flex justify-between text-[12px]">
          <span>Receiver&apos;s signature</span>
          <span>For {company?.name || ''}</span>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ChallanPrint />
    </Suspense>
  );
}
