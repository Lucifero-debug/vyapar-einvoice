'use client'
import React, { forwardRef } from 'react'
import {
  orderRefsLabel,
  orderRefsText,
  printableOrderRefs,
} from '@/lib/orderStatus.mjs';
import { splitGst } from '@/lib/gst.mjs';
import { buildHsnSummary, hsnGrandTotal, lineTaxable } from '@/lib/hsnTotals.mjs';
import { addressLines, has } from '@/lib/company.mjs';
import { useCompany } from '@/context/CompanyContext';
import AddIcCallOutlinedIcon from '@mui/icons-material/AddIcCallOutlined';

/**
 * One printed invoice. Shared by the single-invoice page and the date-range
 * print, so a bill looks the same however it is printed.
 */
const InvoiceDocument = forwardRef(({ invoice, isRollStationary }, ref) => {
  // The seller's own details, from the firm that is signed in. This header
  // used to carry a name and a GSTIN written into the source -- the GSTIN was
  // invented, and on a shared instance every firm printed the first firm's.
  const { company } = useCompany();
  const sellerAddress = addressLines(company);

  const items = invoice?.items || [];
  const partyTaxes = invoice?.partyTaxes || [];


  const date = invoice?.date ? new Date(invoice.date).toISOString().substring(0, 10) : '';
  const customer = invoice?.customer?.name || '';
  const phone = invoice?.customer?.phone || '';
  const taxType = invoice?.taxType || 'local';
  const finalAmount = Number(invoice?.finalAmount) || 0;
  const received = Number(invoice?.received) || 0;
  const balanceDue = Number(invoice?.balanceDue) || 0;
  const stateOfSupply = invoice?.stateOfSupply || '';
  const stateCode = invoice?.stateCode || '';
  const shippedTo = invoice?.shippedTo || '';
  const dispatchFrom = invoice?.dispatchFrom || '';
  const transport = invoice?.transport || '';
  const grNo = invoice?.grNo || '';
  const grDate = invoice?.grDate ? new Date(invoice.grDate).toLocaleDateString('en-IN') : '';
  const pvtMark = invoice?.pvtMark || '';
  const caseDetails = invoice?.caseDetails || '';
  const freight = invoice?.freight || '';
  const weight = invoice?.weight || '';
  const ewayBillNo = invoice?.ewayBillNo || '';
  const ewayBillDate = invoice?.ewayBillDate ? new Date(invoice.ewayBillDate).toLocaleDateString('en-IN') : '';
  // Every order this bill draws on, with its date.
  //
  // A bill can draw on more than one order -- the item-wise picker on the
  // billing form makes that routine -- and a single orderNo/orderDate pair
  // can only ever name the last of them. The list is derived from the lines,
  // each of which carries its own order's number and date, and falls back to
  // the header pair for bills raised before that existed or where the clerk
  // typed the customer's own order number by hand.
  const orderRefs = printableOrderRefs(invoice);
  const orderRefsLine = orderRefsText(orderRefs, (d) =>
    new Date(d).toLocaleDateString('en-IN')
  );

// Compute total taxable amount and GST totals. `lineTaxable` lives in
// lib/hsnTotals.mjs so the summary below, and the backfill script, apply the
// very same rule to a line.
const totalTaxableAmount = items.reduce((sum, item) => sum + lineTaxable(item), 0);
const totalGstAmount = items.reduce(
  (sum, item) => sum + (lineTaxable(item) * (Number(item.gstRate) || 0)) / 100,
  0
);

// SGST and CGST have to add up to the tax actually charged. Halving and
// rounding each side independently disagreed with the total on half of all
// amounts, by a paisa.
const { sgst, cgst } = splitGst(totalGstAmount);

// DERIVED from the lines, never read back from the stored `hsnTotals` rows --
// those were truncated by the schema and print as a negative taxable value
// against a total of zero. lib/hsnTotals.mjs has the full account.
const hsnSummary = buildHsnSummary(items);
const hsnRows = Object.entries(hsnSummary);
const hsnGrand = hsnGrandTotal(hsnSummary);

// A seven-column bill does not fit a phone. Rather than let `table-layout:
// fixed` squeeze item names down to a character per line, the table keeps its
// paper width and the wrapper scrolls sideways. Roll stationary is genuinely
// narrow paper, so there it stays fluid.
const tableMinWidth = isRollStationary ? '' : 'min-w-[640px]';
const hsnMinWidth = isRollStationary ? '' : 'min-w-[560px]';
const cellPad = isRollStationary ? 'px-2 py-1.5' : 'px-2 py-2 sm:px-4 sm:py-3';
const headCell = 'text-[11px] font-semibold uppercase tracking-wide text-gray-700 sm:text-xs';

  return (
<div 
  ref={ref} 
  className={`invoice-doc mx-auto my-4 bg-white border border-gray-300 rounded-xl shadow-sm text-gray-900 font-sans transition-all duration-300 sm:my-6
    ${isRollStationary ? 'max-w-[480px] p-3 text-[12px]' : 'max-w-3xl p-4 text-[13px] sm:p-8 sm:text-[14px]'}`}
  style={{
    fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    overflow: "hidden",
  }}
>

        {/* Header */}
        <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="min-w-0">
              {/* Blank prints as nothing. An empty line on a bill is honest;
                  a placeholder that looks like a real GSTIN is not. */}
              <h1 className="text-xl font-extrabold tracking-wide text-gray-800 sm:text-3xl">
                {company.name}
              </h1>
              {sellerAddress.map((line) => (
                <p key={line} className="mt-1 text-xs text-gray-600 sm:text-sm">{line}</p>
              ))}
              {has(company.gstin) && (
                <p className="mt-1 text-xs text-gray-600 sm:text-sm">GSTIN: {company.gstin}</p>
              )}
              {has(company.phone) && (
                <p className="mt-1 flex items-center gap-1 text-xs text-gray-700 sm:text-sm">
                  <AddIcCallOutlinedIcon fontSize="small" /> {company.phone}
                </p>
              )}
            </div>
            <div className="ml-auto h-14 w-14 flex-shrink-0 overflow-hidden rounded-full border border-gray-300 shadow-md sm:ml-0 sm:h-20 sm:w-20">
              <img src={company.logo} alt="" className="w-full h-full object-cover" />
            </div>
          </div>
          {/* Phone: number and date sit side by side under the masthead.
              sm and up: the original stacked block on the right. */}
          <div className="flex items-end justify-between gap-4 border-t border-gray-200 pt-3 sm:block sm:border-0 sm:pt-0 sm:text-right">
            <div>
              <p className="text-xs text-gray-500 sm:text-sm">Invoice No:</p>
              <p className="text-base font-semibold sm:text-lg">{invoice.invoiceNo}</p>
            </div>
            <div className="text-right sm:mt-2">
              <p className="text-xs text-gray-500 sm:text-sm">Date:</p>
              <p className="font-semibold">{date}</p>
            </div>
          </div>
        </header>

        {/* Customer Info */}
        <section className="mb-6 grid grid-cols-1 gap-x-8 gap-y-4 border-t border-b border-gray-300 py-4 sm:grid-cols-2 sm:gap-y-2">
          <div className="min-w-0">
            <h2 className="font-semibold text-gray-700">Bill To:</h2>
            <p className="mt-1 break-words">{customer}</p>
            <p>{phone}</p>
            <p>{stateOfSupply}{stateCode ? ` (${stateCode})` : ''}</p>
              {shippedTo && (
      <>
        <h2 className="font-semibold text-gray-700 mt-4">Shipped To:</h2>
        <p className="break-words">{shippedTo}</p>
      </>
    )}
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-gray-700">Tax Details:</h2>
            <p className="mt-1">Tax Type: {taxType}</p>
            {taxType === 'local' ? (
              <>
                <p>SGST: {sgst.toFixed(2)}</p>
                <p>CGST: {cgst.toFixed(2)}</p>
              </>
            ) : (
              <p>IGST: {totalGstAmount.toFixed(2)}</p>
            )}
               {dispatchFrom && (
      <>
        <h2 className="font-semibold text-gray-700 mt-4">Dispatch From:</h2>
        <p className="break-words">{dispatchFrom}</p>
      </>
    )}
          </div>
        </section>

        {/* Transport Details */}
{(transport || grNo || grDate || pvtMark || caseDetails || freight || weight || ewayBillNo || ewayBillDate || orderRefsLine) && (
  <section className="mb-6 rounded-md border border-gray-300 bg-gray-50 p-3 sm:p-4">
    <h3 className="text-md font-semibold text-gray-700 mb-3">Order Details</h3>
    <div className="grid grid-cols-1 gap-2 text-[13px] text-gray-700 sm:grid-cols-3 sm:gap-3 sm:text-sm">
      {transport && (
        <div className="break-words"><span className="font-medium">Transport:</span> {transport}</div>
      )}
      {grNo && (
        <div className="break-words"><span className="font-medium">GR No:</span> {grNo}</div>
      )}
      {grDate && (
        <div className="break-words"><span className="font-medium">GR Date:</span> {grDate}</div>
      )}
      {pvtMark && (
        <div className="break-words"><span className="font-medium">Pvt Mark:</span> {pvtMark}</div>
      )}
      {caseDetails && (
        <div className="break-words"><span className="font-medium">Case:</span> {caseDetails}</div>
      )}
      {freight && (
        <div className="break-words"><span className="font-medium">Freight:</span> {freight}</div>
      )}
      {weight && (
        <div className="break-words"><span className="font-medium">Weight:</span> {weight} kg</div>
      )}
      {ewayBillNo && (
        <div className="break-words"><span className="font-medium">E-Way Bill No:</span> {ewayBillNo}</div>
      )}
      {ewayBillDate && (
        <div className="break-words"><span className="font-medium">E-Way Bill Date:</span> {ewayBillDate}</div>
      )}
      {orderRefsLine && (
        <div className="break-words sm:col-span-3">
          <span className="font-medium">{orderRefsLabel(orderRefs)}:</span> {orderRefsLine}
        </div>
      )}
    </div>
  </section>
)}

        {/* Items Table */}
<div className="inv-scroll -mx-1 mb-6 overflow-x-auto sm:mx-0">
<table
  className={`inv-table w-full border-collapse ${tableMinWidth} ${
    isRollStationary ? 'text-[11px]' : 'text-[12px] sm:text-sm'
  }`}
  style={{
    tableLayout: "fixed", // widths come from the colgroup below, not from content
    wordBreak: "break-word",
  }}
>
  {/* Without these, `fixed` splits the width seven equal ways and an item name
      gets no more room than a GST percentage -- long names then wrap to one or
      two characters a line. */}
  <colgroup>
    <col className="w-[28%]" />
    <col className="w-[10%]" />
    <col className="w-[13%]" />
    <col className="w-[10%]" />
    <col className="w-[13%]" />
    <col className="w-[9%]" />
    <col className="w-[17%]" />
  </colgroup>
          <thead>
            <tr className="bg-gray-100 border-b border-gray-300">
              <th className={`${cellPad} ${headCell} text-left`}>Item</th>
              <th className={`${cellPad} ${headCell} text-center`}>Qty</th>
              <th className={`${cellPad} ${headCell} text-right`}>Price (₹)</th>
              <th className={`${cellPad} ${headCell} text-right`}>Disc (%)</th>
              <th className={`${cellPad} ${headCell} text-right`}>HSN</th>
              <th className={`${cellPad} ${headCell} text-right`}>GST</th>
              <th className={`${cellPad} ${headCell} text-right`}>Amount (₹)</th>
            </tr>
          </thead>
    <tbody>
  {items.map((item, i) => {

    return (
      <React.Fragment key={i}>
        <tr className="border-b border-gray-200 hover:bg-gray-50">
          <td className={`${cellPad} text-gray-800`}>{item.name}</td>
          <td className={`${cellPad} text-center tabular-nums`}>{item.quantity}</td>
          <td className={`${cellPad} text-right tabular-nums`}>₹{(Number(item.cost) || 0).toFixed(2)}</td>
          <td className={`${cellPad} text-right tabular-nums`}>{(Number(item.discount) || 0).toFixed(2)}%</td>
          <td className={`${cellPad} text-right tabular-nums`}>{item.hsn}</td>
          <td className={`${cellPad} text-right tabular-nums`}>{item.gstRate || 0}%</td>
          <td className={`${cellPad} text-right font-semibold tabular-nums`}>₹{(Number(item.total) || 0).toFixed(2)}</td>
        </tr>
        {item.description && (
          <tr className="border-b border-gray-200 bg-gray-50">
            {/* Seven columns, not five: the row used to stop short of the
                amount column and left a ragged hole in the bill. */}
            <td colSpan={7} className={`${cellPad} text-[12px] italic text-gray-600 sm:text-sm`}>
              Description: {item.description}
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  })}
</tbody>
        </table>
</div>

{hsnRows.length > 0 && (
  <section className="mt-8 sm:mt-10" style={{ breakInside: 'avoid' }}>
    <h2 className="mb-3 border-b pb-1 text-base font-bold text-gray-800 sm:text-lg">
      HSN Code-wise Summary
    </h2>
    <div className="inv-scroll -mx-1 overflow-x-auto sm:mx-0">
<table
  className={`inv-table w-full border border-gray-300 ${hsnMinWidth} ${
    isRollStationary ? 'text-[11px]' : 'text-[12px] sm:text-sm'
  }`}
  style={{
    tableLayout: "fixed",
    wordBreak: "break-word",
  }}
>
  <colgroup>
    <col className="w-[18%]" />
    <col className="w-[16%]" />
    <col className="w-[22%]" />
    <col className="w-[20%]" />
    <col className="w-[24%]" />
  </colgroup>
        <thead className="bg-gray-100">
          <tr>
            <th className={`${cellPad} ${headCell} border-b border-gray-300 text-left`}>HSN Code</th>
            <th className={`${cellPad} ${headCell} border-b border-gray-300 text-right`}>GST Rate (%)</th>
            <th className={`${cellPad} ${headCell} border-b border-gray-300 text-right`}>Taxable (₹)</th>
            <th className={`${cellPad} ${headCell} border-b border-gray-300 text-right`}>GST (₹)</th>
            <th className={`${cellPad} ${headCell} border-b border-gray-300 text-right`}>Total (₹)</th>
          </tr>
        </thead>
        <tbody>
          {hsnRows.map(([hsn, data]) => (
            <tr key={hsn} className="border-b border-gray-200 hover:bg-gray-50">
              <td className={`${cellPad} tabular-nums`}>{hsn}</td>
              <td className={`${cellPad} text-right tabular-nums`}>{data.gstRate.toFixed(2)}%</td>
              <td className={`${cellPad} text-right tabular-nums`}>₹{data.taxable.toFixed(2)}</td>
              <td className={`${cellPad} text-right tabular-nums`}>₹{data.gstAmount.toFixed(2)}</td>
              <td className={`${cellPad} text-right font-medium tabular-nums`}>₹{data.total.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-50 font-semibold">
          <tr>
            <td className={`${cellPad} text-right`} colSpan={2}>Grand Total</td>
            <td className={`${cellPad} text-right tabular-nums`}>₹{hsnGrand.taxable.toFixed(2)}</td>
            <td className={`${cellPad} text-right tabular-nums`}>₹{hsnGrand.gstAmount.toFixed(2)}</td>
            <td className={`${cellPad} text-right tabular-nums`}>₹{hsnGrand.total.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  </section>
)}

{partyTaxes?.length > 0 && (
  <section className="mt-6 w-full space-y-1 sm:ml-auto sm:mt-4 sm:max-w-xs">
    <h3 className="text-md font-semibold text-gray-700 mb-2">Additional Overhead:</h3>
    {partyTaxes.map((tax, idx) => (
      <div key={idx} className="flex justify-between gap-3 text-[13px] text-gray-600 sm:text-sm">
        <span className="break-words">{tax.name} ({tax.rate ? `${tax.rate}%` : `₹${tax.total}`}):</span>
        <span className="whitespace-nowrap tabular-nums">₹{parseFloat(tax.total).toFixed(2)}</span>
      </div>
    ))}
  </section>
)}

        {/* Summary */}
           <section className="mt-8 w-full sm:ml-auto sm:mt-10 sm:max-w-sm" style={{ breakInside: 'avoid' }}>
          <h2 className="text-md font-bold text-gray-800 mb-2 border-b pb-1">Invoice Summary</h2>
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <strong>Total:</strong>
              <span className="tabular-nums">₹{finalAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <strong>Received:</strong>
              <span className="tabular-nums">₹{received.toFixed(2)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <strong>Balance Due:</strong>
              <span className="tabular-nums">₹{balanceDue.toFixed(2)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <strong>Taxable Amount:</strong>
              <span className="tabular-nums">₹{totalTaxableAmount.toFixed(2)}</span>
            </div>
{taxType === 'local' ? (
  <>
    <div className="flex justify-between gap-4">
      <strong>SGST:</strong>
      <span className="tabular-nums">₹{sgst.toFixed(2)}</span>
    </div>
    <div className="flex justify-between gap-4">
      <strong>CGST:</strong>
      <span className="tabular-nums">₹{cgst.toFixed(2)}</span>
    </div>
  </>
) : (
  <div className="flex justify-between gap-4">
    <strong>IGST:</strong>
    <span className="tabular-nums">₹{totalGstAmount.toFixed(2)}</span>
  </div>
)}
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-10 border-t border-gray-300 pt-5 text-center text-[13px] text-gray-600 sm:mt-12 sm:pt-6 sm:text-sm">
          <p>Thank you for doing business with us.</p>
          <p>Please contact us if you have any questions about this invoice.</p>
        </footer>
      </div>
  );
});

InvoiceDocument.displayName = 'InvoiceDocument';

export default InvoiceDocument;
