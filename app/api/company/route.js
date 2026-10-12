import { NextResponse } from "next/server";
import Company from "@/models/companyModel";
import { connect } from "@/lib/mongodb";
import { FIELD_NAMES, companyFrom, irpMissing } from "@/lib/company.mjs";
import { CREDENTIAL_FIELDS, credentialState } from "@/lib/einvoiceCredentials.mjs";
import { secretBoxReady } from "@/lib/secretBox.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * The signed-in firm's own details — the letterhead on every document.
 *
 * Readable by any role, because a biller cannot print a bill without it. What
 * comes back is `companyFrom()`'s shape and nothing else: the projection asks
 * for the profile fields by name, so a credential column added to `companies`
 * later is not quietly served to the browser.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    // Scoped by the id on the session, explicitly. `companies` IS the tenant
    // list, so the tenant plugin deliberately does not apply to it -- nothing
    // else is narrowing this query (lib/tenantScope.mjs).
    // `+einvoicePasswordEnc` is asked for only so the reply can say whether
    // one exists. The value itself never leaves this function -- see
    // credentialState(), which turns it into a boolean.
    const record = await Company.findById(auth.companyId)
      // `logo` and `invoicePrefs` are named here but are NOT in FIELD_NAMES:
      // that array is the profile FORM's text fields and doubles as the
      // update allowlist, and neither of these is a text field the form
      // posts. Asking for them by name keeps the projection explicit, which
      // is the property this select exists for.
      .select(
        [...FIELD_NAMES, "logo", "invoicePrefs", ...CREDENTIAL_FIELDS, "+einvoicePasswordEnc"].join(
          " "
        )
      )
      .lean();

    if (!record) {
      return NextResponse.json(
        { success: false, error: "This firm's record is missing." },
        { status: 404 }
      );
    }

    const company = companyFrom(record);

    return NextResponse.json({
      success: true,
      company,
      // What still has to be filled in before an invoice can be reported to
      // the IRP. Sent with the record so the profile page needs no second call.
      irpMissing: irpMissing(company),
      einvoice: credentialState(record),
      // Without a key on the server there is nowhere safe to put a password,
      // so the form says so rather than accepting one and dropping it.
      einvoiceKeyConfigured: secretBoxReady(),
    });
  } catch (error) {
    console.error("Error reading the company profile:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
