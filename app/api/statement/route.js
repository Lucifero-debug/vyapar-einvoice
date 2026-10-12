import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Company from "@/models/companyModel";
import Customer from "@/models/custModel";
import Ledger from "@/models/ledgerModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { companyAddress, companyFrom } from "@/lib/company.mjs";
import { reportResponse, isReportFormat, formatOf } from "@/lib/reportHttp.js";
import { isPreset, resolvePeriod } from "@/lib/reportPeriods.mjs";
import {
  accountsForSide,
  isStatementFormat,
  isStatementSide,
  monthWise,
  statement,
  statementProblem,
  statementSheets,
  statementSide,
} from "@/lib/statements.mjs";

// A statement is a position as at today over a period of postings. Every
// invoice and receipt changes it, so a cached statement is a wrong statement
// -- the same reason /api/account-book and /api/item-stock say this.
export const dynamic = "force-dynamic";

/**
 * Customer and supplier statements.
 *
 *   side      customer | supplier
 *   account   the party's name, or omitted to get the picker's options
 *   preset    one of lib/reportPeriods.mjs's thirteen
 *   from,to   inclusive IST calendar days; required when preset=custom
 *   format    json | csv | xlsx
 *   view      detailed | monthly -- which table the CSV downloads
 *
 * ONE ROUTE SERVES THE SCREEN AND BOTH DOWNLOADS. That is not tidiness: it is
 * how the spec's rule that a user who cannot see a report cannot download it
 * is made true by construction rather than by a second permission entry
 * somebody has to remember. See the note atop lib/reportHttp.js.
 *
 * The export is NOT paginated. The screen pages through `lines` itself; the
 * download gets every row the filters matched, which is the spec's "do not
 * silently omit records due to pagination".
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const side = (searchParams.get("side") || "customer").trim();
    const accountName = (searchParams.get("account") || "").trim();
    const preset = (searchParams.get("preset") || "thisFy").trim();
    const view = (searchParams.get("view") || "detailed").trim();
    const format = formatOf(searchParams);

    if (!isStatementSide(side)) {
      return NextResponse.json(
        { success: false, error: "Pick a customer or a supplier statement." },
        { status: 400 }
      );
    }
    if (!isReportFormat(format)) {
      return NextResponse.json(
        { success: false, error: `"${format}" is not a format. Use json, csv or xlsx.` },
        { status: 400 }
      );
    }
    if (!isStatementFormat(view)) {
      return NextResponse.json(
        { success: false, error: `"${view}" is not a statement format.` },
        { status: 400 }
      );
    }
    // Validated rather than quietly defaulted: a preset this build does not
    // know means the caller and the server disagree about what period they
    // are discussing, and a statement is not a thing to guess at.
    if (!isPreset(preset)) {
      return NextResponse.json(
        { success: false, error: `"${preset}" is not a period.` },
        { status: 400 }
      );
    }

    const period = resolvePeriod({
      preset,
      from: searchParams.get("from") || "",
      to: searchParams.get("to") || "",
    });

    // The account master doubles as the chart of accounts here, exactly as
    // Sigfa's CUSMAST does -- parties, cash and bank are all Customer docs
    // told apart by `group`. Only the columns a statement header needs.
    const accounts = await Customer.find(
      {},
      {
        name: 1,
        group: 1,
        openingBal: 1,
        openingMode: 1,
        gstIn: 1,
        phone: 1,
        email: 1,
        address: 1,
        city: 1,
        state: 1,
        stateCode: 1,
        pincode: 1,
      }
    ).lean();

    const available = accountsForSide(accounts, side);

    // First load: the picker's options and nothing else, so the screen can
    // fill its dropdown without a second endpoint.
    if (!accountName) {
      return NextResponse.json({
        success: true,
        side,
        sideLabel: statementSide(side).label,
        accounts: available,
        period,
      });
    }

    const found = accounts.find(
      (a) => String(a.name || "").trim().toLowerCase() === accountName.toLowerCase()
    );
    if (!found) {
      return NextResponse.json(
        { success: false, error: `No account named "${accountName}".`, accounts: available },
        { status: 404 }
      );
    }

    const problems = statementProblem({
      side,
      account: found,
      from: period.from,
      to: period.to,
      format: view,
    });
    if (problems) {
      return NextResponse.json(
        { success: false, error: problems, accounts: available, period },
        { status: 400 }
      );
    }

    // EVERY row for this account, not only the window's. The opening balance
    // is computed from the ones before `from` (lib/accountBooks.mjs's
    // `openingBefore`), so a date filter on this query would produce an
    // opening balance of whatever the master was last typed as -- which is
    // the exact bug the spec's "do not calculate the balance by filtering
    // historical transactions to the selected range" names.
    //
    // Matched on `customerName` only, never on `account`. The latter is the
    // CONTRA side of the same row, and matching both pulls a cash account's
    // own row PLUS every party row naming it as the contra -- the same money
    // twice. /api/ledger and /api/account-book carry the same warning.
    const rows = await Ledger.find(
      { customerName: found.name },
      {
        customerName: 1,
        date: 1,
        account: 1,
        paymentType: 1,
        debit: 1,
        credit: 1,
        narration: 1,
        voucherId: 1,
      }
    )
      .sort({ date: 1, _id: 1 })
      .lean();

    const sheet = statement({
      account: found,
      side,
      rows,
      from: period.from,
      to: period.to,
    });

    // The firm, for the statement's own letterhead. Read from the companies
    // record this session belongs to -- never a hardcoded name, and never a
    // companyId the client sent.
    const companyDoc = await Company.findById(auth.companyId).lean();
    const company = companyFrom(companyDoc);
    const addressLine = companyAddress(company);

    const payload = {
      success: true,
      side,
      sideLabel: statementSide(side).label,
      accounts: available,
      period,
      view,
      company: { ...company, address: addressLine },
      statement: sheet,
      months: monthWise(sheet),
    };

    return reportResponse({
      format,
      payload,
      sheets: statementSheets({
        statement: sheet,
        company,
        companyAddressLine: addressLine,
        format: view,
      }),
      filename: {
        report: `${side}-statement`,
        subject: sheet.account,
        from: period.from,
        to: period.to,
      },
    });
  } catch (err) {
    console.error("Statement error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query above scoped to the caller's
// own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
