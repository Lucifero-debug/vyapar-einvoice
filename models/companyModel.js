import mongoose from "mongoose";
import { EINVOICE_DEFAULT_ENV, EINVOICE_ENVS } from "../lib/einvoiceCredentials.mjs";
import { DEFAULT_FOOTER_NOTE, DEFAULT_PAPER, PAPER_VALUES } from "../lib/invoicePrefs.mjs";

/**
 * A tenant: one trading firm with its own books.
 *
 * This is what `lib/company.mjs` used to be as a hardcoded constant. With more
 * than one firm on the instance, the letterhead on a printed invoice has to
 * come from the firm that owns the invoice, not from a module.
 *
 * Every other collection will carry this document's `_id`, and the session
 * carries it as `cid`. Nothing a request can read exists outside it.
 */
const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // What the GST registration says, when the shop trades under another
    // name. Optional, printed UNDER the trading name rather than instead of
    // it. Declared because Mongoose strict mode drops what is not -- the
    // mistake this project has paid for seven times.
    legalName: { type: String, trim: true, default: "" },
    // Printed on every invoice. Blank until the owner fills it in -- better an
    // empty line on the bill than a placeholder GSTIN that looks real.
    gstin: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    website: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    stateCode: { type: String, trim: true, default: "" },
    pincode: { type: String, trim: true, default: "" },
    bankName: { type: String, trim: true, default: "" },
    bankAccount: { type: String, trim: true, default: "" },
    bankIfsc: { type: String, trim: true, default: "" },
    // === The firm's own logo ===
    //
    // A `data:` URL on this row. The app has no object storage -- cloudinary
    // is in package.json and imported in zero files, and there are no
    // CLOUDINARY_* variables anywhere -- and a logo is a few tens of
    // kilobytes, so it is kept here under a hard 150KB cap enforced on the
    // DECODED bytes by lib/companyLogo.mjs. A bounded exception to the rule
    // that images do not belong in a database, taken deliberately; that
    // module's header has the full reasoning and the one-function path to
    // swapping in object storage later.
    //
    // Blank by default. A firm with no logo prints NOTHING, which is the
    // whole point: the old shared /logo.jpg put one shop's mark on every
    // other shop's tax invoice.
    logo: { type: String, default: "" },

    // === How this firm's documents look ===
    //
    // Presentation only, every one of them. Nothing here changes a figure,
    // a tax rate, an invoice number or a posting -- lib/invoicePrefs.mjs
    // says why that line is hard rather than stylistic, and a test asserts
    // that nothing financial has crept into the list.
    //
    // `_id: false` because this is a value object, not a record: a
    // sub-document id here would be a second thing to migrate for nothing.
    // Every field defaults to the value that preserves TODAY's invoice, so
    // the rows already in the database -- which have no `invoicePrefs` at
    // all -- render exactly as they did before.
    invoicePrefs: {
      type: new mongoose.Schema(
        {
          showLogo: { type: Boolean, default: true },
          showGstin: { type: Boolean, default: true },
          showPhone: { type: Boolean, default: true },
          // Off, because the invoice has never printed an email and
          // defaulting it on would silently change every bill.
          showEmail: { type: Boolean, default: false },
          showAddress: { type: Boolean, default: true },
          showBank: { type: Boolean, default: true },
          // Off, because there is no signature area on the bill today.
          showSignatory: { type: Boolean, default: false },
          paper: { type: String, enum: PAPER_VALUES, default: DEFAULT_PAPER },
          // The two sentences components/InvoiceDocument.jsx has always
          // hard-coded, kept verbatim. NOT "" -- the schema's
          // `default: () => ({})` below materialises this sub-document on
          // the next save of any row, and lib/invoicePrefs.mjs treats an
          // empty footer as the deliberate choice to print none. Defaulting
          // it blank here would therefore have deleted the footer from
          // every firm's invoice the first time they saved their profile.
          footerNote: { type: String, default: DEFAULT_FOOTER_NOTE },
        },
        { _id: false }
      ),
      default: () => ({}),
    },

    // Lets a firm be switched off without deleting its books.
    active: { type: Boolean, default: true },

    // === E-invoicing credentials ===
    //
    // The portal password is ENCRYPTED, not hashed: it has to be sent to the
    // IRP on every token refresh, so it must be recoverable. It is sealed by
    // lib/secretBox.mjs under its own EINVOICE_KEY -- never under AUTH_SECRET,
    // because a leaked session secret must not also let somebody file invoices
    // as this firm.
    //
    // `select: false` keeps it out of every ordinary query, so a route has to
    // ask for it by name to see it at all.
    einvoiceEnabled: { type: Boolean, default: false },
    einvoiceUsername: { type: String, trim: true, default: "" },
    einvoicePasswordEnc: { type: String, default: "", select: false },
    einvoiceEnv: {
      type: String,
      enum: EINVOICE_ENVS.map((e) => e.value),
      default: EINVOICE_DEFAULT_ENV,
    },
  },
  { timestamps: true }
);

// Firms are looked up by id from the session, so no index beyond _id is needed
// yet. Deliberately NOT unique on name: two unrelated shops may genuinely
// share one, and refusing the second signup over that would be absurd.

const Company =
  mongoose.models.companies || mongoose.model("companies", companySchema);

export default Company;
