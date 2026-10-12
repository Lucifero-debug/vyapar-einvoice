import { NextResponse } from "next/server";
import Company from "@/models/companyModel";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  LOGO_FORMAT_WORDS,
  MAX_LOGO_BYTES,
  logoProblem,
  logoSrc,
  storeLogo,
} from "@/lib/companyLogo.mjs";

/**
 * The firm's logo: upload one, or take it off.
 *
 * Owner only -- `/api/company-logo` is mapped to `setup:write` in
 * lib/roles.mjs, the same permission that guards the rest of the firm's
 * profile. A separate route from `/api/company-update` for two reasons: a
 * 200KB body should not ride along with every profile save, and the two can
 * be permissioned and limited independently.
 *
 *
 * WHICH FIRM'S LOGO
 * -----------------
 * `auth.companyId`, from the signed session. Never a companyId in the body,
 * and the body is not even read for one -- which is the brief's "one firm
 * cannot replace or remove another firm's logo through a manipulated API
 * request", made true by there being no field to manipulate. A caller who
 * posts `{ companyId: "<someone else's>" }` writes to their own row.
 *
 * There is no asset to clean up when a logo is replaced: the value lives on
 * the firm's own row, so writing the new one IS removing the old one. That
 * also means there is no shared asset a delete could orphan -- the brief's
 * warning about deleting something another record still references cannot
 * arise here. It would if this moved to object storage, and that is noted in
 * lib/companyLogo.mjs beside the swap it describes.
 *
 *
 * WHAT IS CHECKED, AND WHY IT IS CHECKED ON THE BYTES
 * --------------------------------------------------
 * The browser sends base64. This route decodes it and asks
 * lib/companyLogo.mjs what the BYTES are -- not what the filename claims and
 * not what Content-Type says, because both come from the caller.
 *
 * That is not pedantry about MIME types. The stored value goes into a `src`
 * on a printed page served from this app's own origin, so a
 * `data:text/html;base64,...` accepted here is a script running as the app.
 * The magic-byte check is the only thing between the upload form and that.
 */

// A firm's own logo, changed from the settings page. Never cached.
export const dynamic = "force-dynamic";

/** Decoded base64, or null. Strict: Buffer.from ignores what it cannot parse. */
const decode = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  // A whole data URL or a bare payload -- the form sends the payload, but
  // accepting both means a caller pasting what they see in the column works.
  const payload = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return null;
  try {
    const bytes = Buffer.from(payload, "base64");
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
};

async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    await connect();

    // --- taking the logo off ---
    //
    // Sets it blank, which restores the fallback -- and the fallback is
    // NOTHING, not the old shared /logo.jpg. See lib/companyLogo.mjs.
    if (body?.remove) {
      const record = await Company.findByIdAndUpdate(
        auth.companyId,
        { $set: { logo: "" } },
        { new: true }
      )
        .select("logo")
        .lean();

      if (!record) {
        return NextResponse.json(
          { success: false, error: "This firm's record is missing." },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        message: "Logo removed. Your documents will print without one.",
        logo: "",
      });
    }

    // --- putting one on ---
    const bytes = decode(body?.data);
    if (!bytes) {
      return NextResponse.json(
        { success: false, error: `Send a ${LOGO_FORMAT_WORDS} image.` },
        { status: 400 }
      );
    }

    // Size and type, both from the decoded bytes.
    const problem = logoProblem({ bytes, name: body?.name });
    if (problem) {
      return NextResponse.json({ success: false, error: problem }, { status: 400 });
    }

    // The MIME in the stored value comes from the SNIFFED type, so the
    // declared one cannot reach the column even as a label.
    const logo = storeLogo({ bytes });
    if (!logo) {
      return NextResponse.json(
        { success: false, error: `Send a ${LOGO_FORMAT_WORDS} image.` },
        { status: 400 }
      );
    }

    const record = await Company.findByIdAndUpdate(
      auth.companyId,
      { $set: { logo } },
      { new: true, runValidators: true }
    )
      .select("logo")
      .lean();

    if (!record) {
      return NextResponse.json(
        { success: false, error: "This firm's record is missing." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Logo saved. It will print at the top of your documents.",
      // Read back through the validator, so what the page previews is what
      // a document will actually render.
      logo: logoSrc(record),
      bytes: bytes.length,
      limit: MAX_LOGO_BYTES,
    });
  } catch (error) {
    console.error("Error saving the company logo:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and the firm taken from the session rather
// than from the body. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
