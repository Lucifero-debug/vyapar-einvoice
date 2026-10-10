import mongoose from "mongoose";
import { EINVOICE_DEFAULT_ENV, EINVOICE_ENVS } from "../lib/einvoiceCredentials.mjs";

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
    // Printed on every invoice. Blank until the owner fills it in -- better an
    // empty line on the bill than a placeholder GSTIN that looks real.
    gstin: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    stateCode: { type: String, trim: true, default: "" },
    pincode: { type: String, trim: true, default: "" },
    bankName: { type: String, trim: true, default: "" },
    bankAccount: { type: String, trim: true, default: "" },
    bankIfsc: { type: String, trim: true, default: "" },
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
