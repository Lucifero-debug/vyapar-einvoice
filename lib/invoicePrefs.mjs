/**
 * How a firm wants its documents to LOOK.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/company-branding.test.mjs directly. Never import Mongoose in here.
 *
 *
 * PRESENTATION ONLY. THAT IS A HARD LINE, NOT A STYLE NOTE
 * -------------------------------------------------------
 * Every preference here changes what is drawn on a page and nothing else. No
 * tax rate, no rounding rule, no invoice-number prefix, no default payment
 * type, no "charge freight by default". The reason is not tidiness: a setting
 * that changes a FIGURE changes it for documents already issued, because this
 * app prints a bill from the invoice row plus the firm's current profile. A
 * presentation setting applied to last year's invoice changes how it looks; a
 * financial setting applied to last year's invoice makes it a different bill
 * from the one the customer has and the one that was filed.
 *
 * `PREF_FIELDS` is the whole list, and the route's allowlist is built FROM it
 * -- so a preference that is not declared here cannot be stored, and a test
 * asserts that nothing in it is a financial field.
 *
 *
 * THE DEFAULTS PRESERVE TODAY'S INVOICE, EXACTLY
 * ----------------------------------------------
 * Measured against components/InvoiceDocument.jsx as it stands, not guessed:
 *
 *   logo      shown    -- it renders `company.logo` unconditionally today
 *   GSTIN     shown    -- `has(company.gstin) && ...`
 *   phone     shown    -- `has(company.phone) && ...`
 *   email     HIDDEN   -- the component does not print it at all today, so
 *                         defaulting it on would silently change every bill
 *   address   shown    -- `addressLines(company)`
 *   bank      HIDDEN   -- the component does not print it either
 *   paper     A4       -- what the layout is built for
 *   footer    the two sentences the component has hard-coded today, kept
 *                         verbatim as the default text
 *   signatory HIDDEN   -- there is no signature area on the invoice today
 *
 * So a firm that never opens the settings page sees no change whatever.
 */

const text = (value) => String(value ?? "").trim();

/** What the component prints today, so the default changes nothing. */
export const DEFAULT_FOOTER_NOTE =
  "Thank you for doing business with us.\nPlease contact us if you have any questions about this invoice.";

/**
 * A4 or A5, and what each means to `@page`.
 *
 * A5 is the half sheet a lot of counter printers are loaded with. The layout
 * is responsive, so it needs no second template -- the sheet is narrower and
 * the type scales down with it, which is what `scale` is for.
 */
export const PAPER_SIZES = [
  { value: "A4", label: "A4", css: "A4", scale: 1, blurb: "The usual sheet." },
  {
    value: "A5",
    label: "A5",
    css: "A5",
    scale: 0.82,
    blurb: "Half the sheet, for a counter printer. The type scales down to fit.",
  },
];

export const PAPER_VALUES = PAPER_SIZES.map((p) => p.value);

export const DEFAULT_PAPER = "A4";

export const isPaperSize = (value) => PAPER_VALUES.includes(text(value));

export const paperSize = (value) =>
  PAPER_SIZES.find((p) => p.value === text(value)) || PAPER_SIZES[0];

export const MAX_FOOTER_LENGTH = 400;

/**
 * Every preference, with the default that preserves today's document.
 *
 * `kind` is how the form renders it and how the route coerces it -- a
 * boolean is `Boolean(...)`, a choice is checked against its list, text is
 * trimmed and capped. Nothing is written by spreading a request body.
 */
export const PREF_FIELDS = [
  {
    name: "showLogo",
    kind: "boolean",
    default: true,
    label: "Show the logo",
    hint: "Nothing prints until you upload one -- a blank space, never another firm's mark.",
  },
  {
    name: "showGstin",
    kind: "boolean",
    default: true,
    label: "Show the GSTIN",
    hint: "A registered firm must print it on a tax invoice. Turn it off only if you are not registered.",
  },
  {
    name: "showPhone",
    kind: "boolean",
    default: true,
    label: "Show the phone number",
  },
  {
    name: "showEmail",
    kind: "boolean",
    default: false,
    label: "Show the email address",
    hint: "Off today, because the invoice has never printed it.",
  },
  {
    name: "showAddress",
    kind: "boolean",
    default: true,
    label: "Show the address",
  },
  {
    name: "showBank",
    kind: "boolean",
    // OFF, like showEmail and for the same reason: the invoice has never
    // printed bank details, so defaulting it on would change every bill.
    // The fields are already on the profile and the block is already
    // written (CompanyBank in components/CompanyBrand.jsx) -- this switch
    // is what puts it on the page.
    default: false,
    label: "Show the bank details",
    hint: "Your bank, account number and IFSC, at the foot of the bill. Off today, because the invoice has never printed them.",
  },
  {
    name: "showSignatory",
    kind: "boolean",
    default: false,
    label: "Leave room for a signature",
    hint: 'Adds an "Authorised Signatory" line at the foot of the bill.',
  },
  {
    name: "paper",
    kind: "choice",
    values: PAPER_VALUES,
    default: DEFAULT_PAPER,
    label: "Paper",
  },
  {
    name: "footerNote",
    kind: "text",
    maxLength: MAX_FOOTER_LENGTH,
    default: DEFAULT_FOOTER_NOTE,
    label: "Footer note",
    hint: "Printed at the foot of every bill. Your terms, your thanks, or nothing at all.",
  },
];

export const PREF_NAMES = PREF_FIELDS.map((f) => f.name);

export const DEFAULT_PREFS = Object.freeze(
  Object.fromEntries(PREF_FIELDS.map((f) => [f.name, f.default]))
);

/**
 * A stored (or posted) object as the preferences a document reads.
 *
 * Only the declared names, each coerced by its kind. An absent preference
 * takes its default, which is what makes every existing `companies` row --
 * none of which has this sub-document at all -- render exactly as before.
 *
 * `undefined` means absent and takes the default; `false` does NOT. The
 * difference matters: `showEmail: false` is a choice and `??` respects it
 * where `||` would quietly turn it back on.
 */
export const prefsFrom = (record) => {
  const source = record?.invoicePrefs ?? record ?? {};
  const out = {};

  for (const field of PREF_FIELDS) {
    const given = source?.[field.name];

    if (field.kind === "boolean") {
      out[field.name] = given === undefined || given === null ? field.default : Boolean(given);
      continue;
    }
    if (field.kind === "choice") {
      out[field.name] = field.values.includes(text(given)) ? text(given) : field.default;
      continue;
    }
    // text. An empty string is a CHOICE -- "print no footer" -- so it is kept
    // rather than replaced by the default. Only an absent key defaults.
    if (given === undefined || given === null) {
      out[field.name] = field.default;
      continue;
    }
    out[field.name] = String(given).slice(0, field.maxLength || MAX_FOOTER_LENGTH).trim();
  }

  return out;
};

/**
 * What is wrong with the posted preferences, as [{ field, message }].
 *
 * Short, because almost nothing here can be wrong: a boolean coerces and a
 * bad choice falls back. The two that can be refused are a paper size this
 * build cannot print and a footer longer than the foot of a page.
 */
export const prefProblems = (posted) => {
  const problems = [];
  const source = posted?.invoicePrefs ?? posted ?? {};

  const paper = source.paper;
  if (paper !== undefined && paper !== null && !isPaperSize(paper)) {
    problems.push({
      field: "paper",
      message: `Paper has to be ${PAPER_VALUES.join(" or ")}.`,
    });
  }

  const note = source.footerNote;
  if (typeof note === "string" && note.length > MAX_FOOTER_LENGTH) {
    problems.push({
      field: "footerNote",
      message: `The footer note has to be under ${MAX_FOOTER_LENGTH} characters. That one is ${note.length}.`,
    });
  }

  return problems;
};

/**
 * The footer note as lines, for the component to print.
 *
 * Blank lines dropped, so a note with a trailing newline does not add an
 * empty paragraph to the bill.
 */
export const footerLines = (prefs) =>
  text(prefsFrom(prefs).footerNote)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Should this detail print, given the preference AND whether there is one?
 *
 * Both halves, in one place. A preference turned on for a field the firm has
 * left blank must still print nothing -- "GSTIN:" with nothing after it is
 * worse on a tax invoice than no line at all, and it is the mistake a
 * component makes when it checks only the preference.
 */
export const showsDetail = (prefs, name, value) => {
  const resolved = prefsFrom(prefs);
  const pref = {
    gstin: "showGstin",
    phone: "showPhone",
    email: "showEmail",
    address: "showAddress",
    logo: "showLogo",
    bank: "showBank",
  }[text(name)];
  if (!pref) return false;
  if (!resolved[pref]) return false;
  return Boolean(value) && text(value).length > 0;
};

/** The `@page` rule a printed document needs for its paper. */
export const pageRuleFor = (prefs) => {
  const paper = paperSize(prefsFrom(prefs).paper);
  return { size: paper.css, scale: paper.scale, value: paper.value };
};
