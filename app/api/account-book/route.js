import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Customer from "@/models/custModel";
import Ledger from "@/models/ledgerModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { accountBook, bookProblems, dayWise, groupBook, isBookKind } from "@/lib/accountBooks.mjs";
import { ACCOUNT_GROUPS, accountsForBook, resolveGroup } from "@/lib/accountGroups.mjs";

// Every posting changes these, so a cached book is a wrong book -- the same
// reason item-stock says this.
export const dynamic = "force-dynamic";

/**
 * Cash Book, Bank Book and A/C Ledger, from one route.
 *
 * Sigfa has them as separate menu items; they are the same sheet with a
 * different account selected, and serving them from one place is what stops a
 * cash book and a party ledger ever disagreeing about what a balance means.
 * The note atop lib/accountBooks.mjs has the full reasoning.
 *
 *   kind     cash | bank | ledger
 *   account  the account name, or omitted with `group` for group-wise
 *   group    Sigfa's "A/C Ledger Group Wise": every account in one group
 *   from,to  inclusive, as IST calendar days
 *   daywise  also return Sigfa's one-line-per-day summary
 *
 * With neither `account` nor `group`, it answers with the accounts this book
 * covers and nothing else -- which is what the screen asks for on first load,
 * so it can populate the picker without a second endpoint.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const kind = (searchParams.get("kind") || "ledger").trim();
    const accountName = (searchParams.get("account") || "").trim();
    const groupName = (searchParams.get("group") || "").trim();
    const from = searchParams.get("from") || "";
    const to = searchParams.get("to") || "";
    const wantDayWise = searchParams.get("daywise") === "1";

    if (!isBookKind(kind)) {
      return NextResponse.json(
        { success: false, error: "Pick a book: cash, bank or ledger." },
        { status: 400 }
      );
    }

    // The account master doubles as the chart of accounts here, exactly as
    // Sigfa's CUSMAST does -- parties, cash and bank are all Customer docs
    // distinguished by `group`.
    const accounts = await Customer.find(
      {},
      { name: 1, group: 1, openingBal: 1, openingMode: 1 }
    ).lean();

    const available = accountsForBook(accounts, kind).map((a) => ({
      _id: a._id,
      name: a.name,
      group: a.group || "",
      // What the group resolves to in the chart of accounts, or null for
      // anything unrecognised. The screen shows that plainly rather than
      // guessing -- an account filed under "Mumbai Party" is not evidence
      // that it is a debtor.
      resolvedGroup: resolveGroup(a.group)?.name || null,
    }));

    // First load: the picker's options, nothing more.
    if (!accountName && !groupName) {
      return NextResponse.json({
        success: true,
        kind,
        accounts: available,
        groups: ACCOUNT_GROUPS.map((g) => ({ code: g.code, name: g.name, main: g.main })),
      });
    }

    // Which accounts this request covers. One name, or every account in a
    // group for Sigfa's group-wise ledger.
    let wanted;
    if (groupName) {
      const group = resolveGroup(groupName);
      if (!group) {
        return NextResponse.json(
          { success: false, error: `"${groupName}" is not a group in the chart of accounts.` },
          { status: 400 }
        );
      }
      wanted = accounts.filter((a) => resolveGroup(a.group)?.code === group.code);
      if (!wanted.length) {
        return NextResponse.json({
          success: true,
          kind,
          accounts: available,
          group: group.name,
          books: [],
          groupTotals: groupBook(group.name, []),
          message: `No accounts are filed under ${group.name}.`,
        });
      }
    } else {
      const found = accounts.find(
        (a) => String(a.name || "").trim().toLowerCase() === accountName.toLowerCase()
      );
      if (!found) {
        return NextResponse.json(
          { success: false, error: `No account named "${accountName}".` },
          { status: 404 }
        );
      }
      wanted = [found];
    }

    const problems = bookProblems({ kind, account: wanted[0]?.name, from, to });
    if (problems.length) {
      return NextResponse.json({ success: false, error: problems[0], problems }, { status: 400 });
    }

    // Every row for every account in scope, in ONE query. A group-wise ledger
    // over Sundry Debtors is eighty accounts; eighty queries would be eighty
    // round trips to draw one sheet.
    //
    // Matched on `customerName` only, never on `account`. The latter is the
    // CONTRA side of the same row: matching both pulled a cash account's own
    // aggregate row PLUS every party row naming it as the contra -- the same
    // money twice, the second time from the other side's point of view. The
    // existing /api/ledger route carries the same warning.
    const names = wanted.map((a) => a.name);
    const rows = await Ledger.find(
      { customerName: { $in: names } },
      { customerName: 1, date: 1, account: 1, paymentType: 1, debit: 1, credit: 1, narration: 1, voucherId: 1 }
    )
      .sort({ date: 1, _id: 1 })
      .lean();

    const byAccount = new Map(names.map((n) => [n, []]));
    for (const row of rows) {
      const bucket = byAccount.get(row.customerName);
      if (bucket) bucket.push(row);
    }

    const books = wanted.map((a) => {
      const book = accountBook({
        account: a,
        rows: byAccount.get(a.name) || [],
        // Signed: positive is Dr, negative Cr (lib/balance.mjs). The stored
        // figure is already signed, so `openingMode` is a display cache and
        // is deliberately not consulted.
        openingBal: a.openingBal,
        from,
        to,
      });
      return {
        ...book,
        resolvedGroup: resolveGroup(a.group)?.name || null,
        daywise: wantDayWise ? dayWise(book) : null,
      };
    });

    return NextResponse.json({
      success: true,
      kind,
      accounts: available,
      group: groupName ? resolveGroup(groupName)?.name : null,
      books,
      groupTotals: groupName ? groupBook(resolveGroup(groupName)?.name, books) : null,
    });
  } catch (err) {
    console.error("Account book error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
