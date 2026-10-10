import { NextResponse } from "next/server";
import Company from "@/models/companyModel";
import { connect } from "@/lib/mongodb";
import {
  FIELD_NAMES,
  companyFrom,
  irpMissing,
  profileProblems,
} from "@/lib/company.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  CREDENTIAL_FIELDS,
  credentialProblems,
  credentialState,
  normalizeEnv,
} from "@/lib/einvoiceCredentials.mjs";
import { seal, secretBoxReady } from "@/lib/secretBox.mjs";

/**
 * Save the firm's own details. Owner only -- see `/company` in lib/roles.mjs.
 *
 * A separate route from the GET because permissions here are per path, not per
 * method: every role has to be able to READ the letterhead, and only the owner
 * may change it. Same reason `/api/customer` and `/api/customer-alter` are two
 * routes.
 *
 * Validated with the same `profileProblems()` the form uses. The form is the
 * convenience; this is the rule. A malformed GSTIN that got past the browser --
 * a stale tab, a direct POST -- is refused here too.
 *
 * It also takes the e-invoice portal credentials, because they live on the same
 * record and the same person maintains them. The password is the only value in
 * this app that is encrypted rather than hashed, is sealed before it touches
 * the database, and is never sent back out -- the reply says whether one
 * exists, nothing more.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json();

    await connect();

    // Whether a password is already stored decides whether one has to be
    // typed now, so it is read before the form is judged. The VALUE is read
    // only to seal a replacement; nothing sends it back out.
    const current = await Company.findById(auth.companyId)
      .select("+einvoicePasswordEnc")
      .lean();

    if (!current) {
      return NextResponse.json(
        { success: false, error: "This firm's record is missing." },
        { status: 404 }
      );
    }

    const problems = [
      ...profileProblems(body),
      ...credentialProblems(body.einvoice || {}, {
        passwordSet: credentialState(current).passwordSet,
      }),
    ];
    if (problems.length) {
      return NextResponse.json(
        {
          success: false,
          error: problems[0].message,
          problems,
        },
        { status: 400 }
      );
    }

    // Built field by field from the normalised shape: trimmed, GSTIN upper
    // case, state code padded back to two digits. Anything else the body
    // carried is not written, rather than relying on Mongoose strict mode to
    // drop it quietly.
    const normalized = companyFrom(body);
    const update = {};
    for (const name of FIELD_NAMES) update[name] = normalized[name];

    // --- e-invoice credentials, when the form sent any ---
    const credentials = body.einvoice;
    if (credentials) {
      update.einvoiceEnabled = Boolean(credentials.enabled);
      update.einvoiceUsername = String(credentials.username || "").trim();
      update.einvoiceEnv = normalizeEnv(credentials.env);

      const password = String(credentials.password || "");
      if (password) {
        // Refuse rather than store it in the clear, or accept it and drop it.
        if (!secretBoxReady()) {
          return NextResponse.json(
            {
              success: false,
              error:
                "EINVOICE_KEY is not configured on the server, so the portal password cannot be stored safely.",
            },
            { status: 503 }
          );
        }
        // Sealed against this firm's id, so the stored blob is useless in
        // another firm's row. lib/secretBox.mjs.
        update.einvoicePasswordEnc = seal(password, { aad: String(auth.companyId) });
      }
      // No password in the body means "leave the stored one alone" -- a form
      // that posted a blank field would otherwise silently wipe it.
    }

    const record = await Company.findByIdAndUpdate(
      auth.companyId,
      { $set: update },
      { new: true, runValidators: true }
    )
      .select([...FIELD_NAMES, ...CREDENTIAL_FIELDS, "+einvoicePasswordEnc"].join(" "))
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
      message: "Saved. This is what prints on your documents from now on.",
      company,
      irpMissing: irpMissing(company),
      // A boolean, never the password.
      einvoice: credentialState(record),
    });
  } catch (error) {
    console.error("Error saving the company profile:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
