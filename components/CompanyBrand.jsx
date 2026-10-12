'use client';

/**
 * The firm's identity, on any document.
 *
 * Two small components, used by the invoice, the statements and the printed
 * reports, so there is ONE place that decides what a letterhead shows and
 * what it leaves out:
 *
 *   <CompanyLogo>   the mark, framed so it cannot be distorted
 *   <CompanyBrand>  the name, address and contact details
 *
 * Not one component for the whole header, deliberately. The invoice puts the
 * firm on the left with the bill number on the right; a report centres the
 * firm over the sheet. Forcing both through one layout would mean a prop that
 * switches between two designs, which is two components wearing a hat. These
 * two are the parts that must AGREE -- which detail prints, and whether the
 * logo is cropped -- and each page composes them its own way.
 *
 *
 * EVERY DETAIL IS GATED TWICE
 * ---------------------------
 * By the firm's preference, and by whether the firm actually filled it in.
 * `showsDetail` in lib/invoicePrefs.mjs does both in one call, because a
 * component that checks only the preference prints "GSTIN:" with nothing
 * after it -- which on a tax invoice is worse than no line at all, and is the
 * mistake this helper exists to prevent.
 */

import React from 'react';
import { addressLines, companyFrom } from '@/lib/company.mjs';
import { LOGO_FRAME, logoSrc } from '@/lib/companyLogo.mjs';
import { prefsFrom, showsDetail } from '@/lib/invoicePrefs.mjs';

/**
 * The firm's mark, or nothing.
 *
 * NOTHING when the firm has not uploaded one -- never a stand-in, and never
 * the old shared /public/logo.jpg that used to print one shop's mark on every
 * other shop's invoice. lib/companyLogo.mjs has that history.
 *
 * `object-contain` in a fixed-height, auto-width box: the whole mark fits
 * inside and the spare space is left empty. The invoice used to frame it
 * `rounded-full object-cover`, which crops to fill, so a wordmark wider than
 * it was tall was printed as a circle cut from the middle of it.
 */
export function CompanyLogo({ company, prefs, variant = 'screen', className = '' }) {
  const resolved = prefsFrom(prefs ?? company);
  const src = logoSrc(company);
  if (!resolved.showLogo || !src) return null;

  return (
    <img
      src={src}
      // Decorative beside the firm's name, which is right there as text. An
      // alt repeating it would have a screen reader say the name twice.
      alt=""
      className={`${LOGO_FRAME[variant] || LOGO_FRAME.screen} ${className}`.trim()}
      // So a logo whose data has been corrupted leaves a gap rather than a
      // broken-image icon in the middle of a letterhead.
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  );
}

/**
 * The firm's name and details, in the order a letterhead reads them.
 *
 * `size` is the only thing that varies between documents: an invoice shouts
 * the firm's name, a report states it.
 */
export function CompanyBrand({ company, prefs, size = 'invoice', align = 'left' }) {
  const firm = companyFrom(company);
  const resolved = prefsFrom(prefs ?? company);
  const lines = resolved.showAddress ? addressLines(firm) : [];

  const nameClass =
    size === 'invoice'
      ? 'text-xl font-extrabold tracking-wide text-gray-800 sm:text-3xl'
      : 'doc-org';
  const metaClass = size === 'invoice' ? 'mt-1 text-xs text-gray-600 sm:text-sm' : 'doc-meta';

  return (
    <div className={align === 'center' ? 'text-center' : 'min-w-0'}>
      {/* Blank prints as nothing. An empty line on a bill is honest; a
          placeholder that looks like a real firm is not. */}
      <h1 className={nameClass}>{firm.name}</h1>

      {/* The registered name UNDER the trading one, not instead of it: the
          customer looks for the name they know and the auditor for the
          registered one. Only when it actually differs -- a firm that typed
          the same name twice gets one line. */}
      {firm.legalName && firm.legalName.toLowerCase() !== firm.name.toLowerCase() ? (
        <p className={metaClass}>{firm.legalName}</p>
      ) : null}

      {lines.map((line) => (
        <p key={line} className={metaClass}>
          {line}
        </p>
      ))}

      {showsDetail(resolved, 'gstin', firm.gstin) && (
        <p className={metaClass}>GSTIN: {firm.gstin}</p>
      )}

      {/* Phone, email and website on one line when there is more than one of
          them, so three optional details do not leave three near-empty rows
          across the top of the sheet. */}
      {(() => {
        const contacts = [
          showsDetail(resolved, 'phone', firm.phone) ? firm.phone : '',
          showsDetail(resolved, 'email', firm.email) ? firm.email : '',
          // The website follows the email preference: it is the same kind of
          // detail and a separate switch for it would be a setting nobody
          // asked for.
          showsDetail(resolved, 'email', firm.website) ? firm.website.replace(/^https?:\/\//i, '') : '',
        ].filter(Boolean);
        if (!contacts.length) return null;
        return <p className={metaClass}>{contacts.join(' · ')}</p>;
      })()}
    </div>
  );
}

/**
 * The firm's bank details, where a document already shows them.
 *
 * Its own component because it sits at the FOOT of a bill rather than in the
 * masthead, and because it is three fields that are either all worth printing
 * or not worth the space.
 */
export function CompanyBank({ company, prefs, className = '' }) {
  const firm = companyFrom(company);
  const resolved = prefsFrom(prefs ?? company);
  if (!resolved.showBank) return null;

  const rows = [
    ['Bank', firm.bankName],
    ['A/C', firm.bankAccount],
    ['IFSC', firm.bankIfsc],
  ].filter(([, value]) => value);

  if (!rows.length) return null;

  return (
    <div className={className}>
      {rows.map(([label, value]) => (
        <p key={label} className="text-xs text-gray-600 sm:text-sm">
          <span className="font-medium">{label}:</span> {value}
        </p>
      ))}
    </div>
  );
}

/**
 * The foot of a document: the firm's note, and a signature line when asked.
 *
 * The note's default is the two sentences the invoice has always printed, so
 * a firm that never opens the settings page sees the bill it saw before --
 * lib/invoicePrefs.mjs sets that out field by field.
 */
export function DocumentFooter({ company, prefs, lines, className = '' }) {
  const resolved = prefsFrom(prefs ?? company);
  const notes = lines || [];

  if (!notes.length && !resolved.showSignatory) return null;

  return (
    <footer className={className}>
      {notes.length ? (
        <div className="text-center text-[13px] text-gray-600 sm:text-sm">
          {notes.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      {resolved.showSignatory ? (
        <div className="mt-8 flex justify-end">
          <div className="w-52 border-t border-gray-400 pt-1 text-center text-xs text-gray-700">
            Authorised Signatory
          </div>
        </div>
      ) : null}
    </footer>
  );
}

export default CompanyBrand;
