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

/** The logo is a file in /public, not a column. Replace public/logo.jpg. */
export const COMPANY_LOGO = "/logo.jpg";

/**
 * What the owner fills in, in the order the form shows it.
 *
 * `required` is only about this form being usable; `irp` marks the ones the
 * IRP will reject an e-invoice for missing. A firm that never files an
 * e-invoice can leave those blank and still print a GST invoice.
 */
export const PROFILE_FIELDS = [
  { name: "name", label: "Business name", required: true, placeholder: "SURYAVANSH TEXTILES" },
  { name: "gstin", label: "GSTIN", irp: true, maxLength: 15, placeholder: "07ABCDE1234F1Z5",
    hint: "15 characters. Its first two digits are your state code." },
  { name: "phone", label: "Phone", placeholder: "+91 98111 22233" },
  { name: "email", label: "Email", placeholder: "billing@yourfirm.in" },
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
  logo: COMPANY_LOGO,
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
