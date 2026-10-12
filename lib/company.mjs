/**
 * The firm's own details — whose they are, and what makes them printable.
 *
 * HISTORY, because it explains the shape of this file.
 *
 * These used to be typed into five different files, and they disagreed: the
 * invoice printed "Prashant Enterprise" with the GSTIN 12ABCDE3456F7Z8 — a
 * number somebody made up — while the ledger, the stock report and the voucher
 * register printed "SURYAVANSH TEXTILES". A customer receiving a bill and a
 * statement got two different companies, and the bill was not a valid tax
 * invoice.
 *
 * Collecting them into one constant fixed the disagreement and left a worse
 * problem: one constant cannot serve two firms. With the instance shared,
 * every firm's invoice printed the first firm's letterhead.
 *
 * So there is no constant any more. The details live on the firm's own row in
 * `companies`, the owner fills them in at /company, and this module is the
 * shape and the rules around them:
 *
 *   companyFrom()     a record -> the object every document reads
 *   addressLines()    how the address is laid out, in one place
 *   profileProblems() what is wrong with what the owner typed
 *   irpMissing()      what still has to be filled in before e-invoicing works
 *
 * Pure, so the profile form, the printed invoice and a bare `node` test all
 * import the same rules. Nothing here reads the database.
 */

import { normalizeStateCode } from "./gst.mjs";
import { DEFAULT_PREFS, prefsFrom } from "./invoicePrefs.mjs";
import { logoSrc } from "./companyLogo.mjs";

/**
 * THE SHARED LOGO IS GONE. It used to be:
 *
 *     export const COMPANY_LOGO = "/logo.jpg";
 *
 * one file in /public -- still there, 100KB of it -- printed at the top of
 * every firm's invoice. It was the last piece of shared branding left from
 * when this app served one shop: the name, the GSTIN and the address were
 * moved onto the `companies` row, and the file in /public was not, so the
 * second firm to sign up got the first firm's mark on their tax invoices.
 *
 * Each firm's own logo now lives on its own row and is validated, stored and
 * framed by lib/companyLogo.mjs. A firm with none prints nothing, which is
 * the same decision this module already makes about the GSTIN: a blank line
 * on a bill is honest, and a plausible-looking stand-in is not.
 *
 * `public/logo.jpg` can be deleted once no deployment is serving an older
 * build. Nothing in the code references it any more.
 */

/**
 * What the owner fills in, in the order the form shows it.
 *
 * `required` is only about this form being usable; `irp` marks the ones the
 * IRP will reject an e-invoice for missing. A firm that never files an
 * e-invoice can leave those blank and still print a GST invoice.
 */
export const PROFILE_FIELDS = [
  { name: "name", label: "Business name", required: true, placeholder: "SURYAVANSH TEXTILES" },
  // What the GST registration says, when the shop trades under another name.
  // Optional, and printed under the trading name rather than instead of it:
  // a customer looks for the name they know, and the auditor for the
  // registered one.
  { name: "legalName", label: "Legal name", placeholder: "If your registration says something else",
    hint: "Only if it differs from the name above." },
  { name: "gstin", label: "GSTIN", irp: true, maxLength: 15, placeholder: "07ABCDE1234F1Z5",
    hint: "15 characters. Its first two digits are your state code." },
  { name: "phone", label: "Phone", placeholder: "+91 98111 22233" },
  { name: "email", label: "Email", placeholder: "billing@yourfirm.in" },
  { name: "website", label: "Website", placeholder: "https://yourfirm.in" },
  { name: "address", label: "Address", irp: true, placeholder: "LIG Flats No. 68, Third Floor, Sarita Vihar" },
  { name: "city", label: "City", irp: true, placeholder: "New Delhi" },
  { name: "state", label: "State", placeholder: "Delhi" },
  { name: "stateCode", label: "State code", irp: true, maxLength: 2, placeholder: "07",
    hint: "The two-digit GST code for your state." },
  { name: "pincode", label: "PIN code", irp: true, maxLength: 6, placeholder: "110076" },
  { name: "bankName", label: "Bank", placeholder: "State Bank of India" },
  { name: "bankAccount", label: "Account number", placeholder: "Printed on the invoice" },
  { name: "bankIfsc", label: "IFSC", maxLength: 11, placeholder: "SBIN0001234" },
];

export const FIELD_NAMES = PROFILE_FIELDS.map((f) => f.name);

const labelOf = (name) =>
  PROFILE_FIELDS.find((f) => f.name === name)?.label || name;

/** Every field blank. What a document shows before the profile is filled in. */
export const BLANK_COMPANY = Object.freeze({
  ...Object.fromEntries(FIELD_NAMES.map((name) => [name, ""])),
  // Blank, not a path. See the note where COMPANY_LOGO used to be.
  logo: "",
  // Every preference at the value that preserves today's document --
  // lib/invoicePrefs.mjs explains each default and what it was measured
  // against.
  invoicePrefs: DEFAULT_PREFS,
});

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/**
 * True when a detail is worth printing. Keeps blanks off the document.
 *
 * Falsy values are not worth printing, so a field left as 0 or false prints
 * as nothing rather than as "0" -- the same rule this helper has always had.
 */
export const has = (value) => Boolean(value && text(value));

/**
 * A `companies` row (or an API response) as the object documents read.
 *
 * Only the known fields, so a row that later grows a credential column cannot
 * reach a printed page by accident. Missing becomes "", never undefined --
 * "GSTIN: undefined" on a tax invoice is the failure this prevents.
 */
export const companyFrom = (record) => {
  const source = record || {};
  const company = { ...BLANK_COMPANY };
  for (const name of FIELD_NAMES) company[name] = text(source[name]);
  company.stateCode = normalizeStateCode(company.stateCode);
  // The logo goes through its own validator rather than being copied: the
  // value ends up in a `src` on a printed page, and a stored value that is
  // not one of the three image types this app accepts resolves to no logo
  // at all. lib/companyLogo.mjs says why that guard is the important one.
  company.logo = logoSrc(source);
  // Absent on every row written before this feature, which is exactly why
  // the defaults are the ones that change nothing.
  company.invoicePrefs = prefsFrom(source);
  // A GSTIN and an IFSC are upper case by definition. Normalising here rather
  // than in the form means what is validated, what is stored and what is
  // printed are the same string, whatever the owner's keyboard did.
  company.gstin = company.gstin.toUpperCase();
  company.bankIfsc = company.bankIfsc.toUpperCase();
  return company;
};

/**
 * The address, as lines. One place, so the invoice, the ledger and the stock
 * report cannot lay it out differently.
 *
 *   LIG Flats No. 68, Third Floor, Sarita Vihar
 *   New Delhi, Delhi - 110076
 */
export const addressLines = (company) => {
  const c = companyFrom(company);
  const locality = [c.city, c.state].filter(has).join(", ");
  const withPin = [locality, c.pincode].filter(has).join(" - ");
  return [c.address, withPin].filter(has);
};

/** The address on one line, for a report header. */
export const companyAddress = (company) => addressLines(company).join(", ");

/* --------------------------------------------------------------- validation */

// The canonical GSTIN shape: two state digits, a ten-character PAN, an entity
// number, a letter, and a checksum. Deliberately not checking the checksum --
// getting that wrong would reject a real number, which is worse than letting a
// typo through to the IRP, which checks it properly anyway.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

/**
 * What is wrong with what the owner typed, as [{ field, message }].
 *
 * Blank is allowed nearly everywhere: a firm part-way through filling this in
 * should be able to save. What is NOT allowed is a value that is present and
 * wrong, because a malformed GSTIN prints on every bill and a state code that
 * disagrees with the GSTIN is rejected by the IRP with an error nobody can
 * read.
 */
export const profileProblems = (form) => {
  const c = companyFrom(form);
  const problems = [];
  const add = (field, message) => problems.push({ field, message });

  if (!has(c.name)) add("name", `${labelOf("name")} is required.`);

  // Checked before the GSTIN cross-check below, so a state code that is simply
  // unreadable gets one message rather than two.
  const typedStateCode = has(form?.stateCode);
  if (typedStateCode && !has(c.stateCode))
    add("stateCode", "A state code is two digits, like 07 for Delhi.");

  if (has(c.gstin)) {
    const gstin = c.gstin;
    const codeInGstin = gstin.slice(0, 2);
    if (gstin.length !== 15) add("gstin", "A GSTIN is exactly 15 characters.");
    else if (!GSTIN.test(gstin)) add("gstin", "That does not look like a GSTIN.");
    else if (!has(c.stateCode)) {
      if (!typedStateCode)
        add("stateCode", `Fill in the state code your GSTIN starts with: ${codeInGstin}.`);
    } else if (codeInGstin !== c.stateCode)
      add("stateCode", `Your GSTIN starts with ${codeInGstin}, so the state code must be ${codeInGstin}.`);
  }

  if (has(c.pincode) && !/^[1-9][0-9]{5}$/.test(c.pincode))
    add("pincode", "A PIN code is six digits.");

  if (has(c.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))
    add("email", "That does not look like an email address.");

  if (has(c.phone) && text(c.phone).replace(/\D/g, "").length < 10)
    add("phone", "A phone number needs at least ten digits.");

  // Must be http(s), because this value becomes a link on a printed page and
  // in the settings form. A bare "yourfirm.in" is accepted and corrected on
  // the way in by `companyFrom`? -- no: it is REFUSED, with the fix named.
  // Silently prefixing a scheme guesses at https for a host that may only
  // serve http, and a link that 404s on a bill is worse than a typo caught
  // at the point of typing.
  if (has(c.website) && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(c.website))
    add("website", "Start the website with http:// or https://, like https://yourfirm.in.");

  if (has(c.bankIfsc) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(c.bankIfsc))
    add("bankIfsc", "An IFSC is eleven characters, like SBIN0001234.");

  return problems;
};

/** The same answer as a yes/no, for a caller that does not show the reasons. */
export const profileIsValid = (form) => profileProblems(form).length === 0;

/* ------------------------------------------------------- e-invoice readiness */

/**
 * Which mandatory seller details are still missing, by label.
 *
 * The IRP rejects a payload missing any of them, with a code rather than a
 * sentence, so it is worth saying plainly on the profile page instead.
 */
export const irpMissing = (company) => {
  const c = companyFrom(company);
  return PROFILE_FIELDS.filter((f) => f.irp && !has(c[f.name])).map((f) => f.label);
};

/** Is this firm's profile complete enough to report an invoice to the IRP? */
export const canReportToIrp = (company) =>
  irpMissing(company).length === 0 && profileIsValid(company);
