import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Series from "../../../models/seriesModel";
import { docTypeLabel, normalizeSeries, seriesProblems } from "@/lib/series.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Create a series -- Sigfa's Series Master, from Setup or with Alt+A from the
 * document you are standing on.
 *
 * `normalizeSeries` produces the whole record: every field of a series,
 * normalized, and NOTHING ELSE -- so a body carrying `companyId` or `_id`
 * cannot write one, and a field Mongoose would silently drop never reaches
 * it. The rules are in lib/series.mjs, pure and swept by
 * scripts/series.test.mjs.
 *
 * This route's own job is the two things that need the database: refusing a
 * duplicate in words rather than as an E11000, and keeping one default per
 * document.
 */
async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json();

    const draft = normalizeSeries(body);

    const problems = seriesProblems({ ...draft, docType: body.docType });
    if (problems.length) {
      return NextResponse.json({ success: false, error: problems[0] }, { status: 400 });
    }

    const series = await withTransaction(async (session) => {
      // Per firm AND per document: series A on a sales invoice and series A
      // on a purchase invoice are two rows, as they are in Sigfa. The
      // collation is belt and braces -- the code is upper-cased before it
      // gets here, but a row written by an older build may not be.
      const clash = await Series.findOne({ code: draft.code, docType: draft.docType })
        .collation({ locale: "en", strength: 2 })
        .session(session)
        .lean();

      if (clash) {
        throw new AbortTransaction(
          {
            success: false,
            error: `Series ${draft.code} already exists for ${docTypeLabel(draft.docType)}.`,
          },
          409
        );
      }

      // One default per document. Cleared rather than refused: ticking the box
      // on a second series plainly means "this one now", and asking the clerk
      // to untick the old one first is a step with no purpose.
      if (draft.isDefault) {
        await Series.updateMany(
          { docType: draft.docType, isDefault: true },
          { $set: { isDefault: false } },
          { session }
        );
      }

      const [created] = await Series.create([draft], { session });
      return created;
    });

    return NextResponse.json({ success: true, series }, { status: 201 });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("Error adding series:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
