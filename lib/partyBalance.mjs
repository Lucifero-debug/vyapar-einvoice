/**
 * Finding the live master record for whoever is selected on an invoice.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * test directly. Never import Mongoose or React in here.
 *
 * WHY THIS EXISTS
 * ---------------
 * The billing pages keep the chosen party in `selectedCustomer`, but that is
 * two different shapes depending on how you got there:
 *
 *   picking from the dropdown  ->  the full customer document, balance and all
 *   editing a saved invoice    ->  the invoice's embedded snapshot, which is
 *                                  only { name, phone, email, custId }
 *
 * So reading `selectedCustomer.lastBal` straight off would show a balance when
 * writing a new bill and nothing at all when opening an old one -- which reads
 * as data loss rather than as a missing join.
 */

/**
 * The party's master record, or null when there isn't one to show.
 *
 * Matches on `custId` first, because a name can have been corrected since the
 * invoice was written, then falls back to the name, because parties are joined
 * BY NAME everywhere else in this app and older snapshots predate `custId`.
 */
export const livePartyFor = (selected, customers = []) => {
  const name = selected?.name;
  if (!name) return null;

  const id = selected.custId || selected._id;
  const byId = id
    ? customers.find((c) => c?._id && String(c._id) === String(id))
    : null;

  return byId || customers.find((c) => c?.name === name) || null;
};

/**
 * The plain-English reading of a Dr/Cr balance, which depends on WHAT KIND of
 * account it is.
 *
 *   a trading party, Dr   ->  they owe us
 *   a trading party, Cr   ->  we owe them
 *   the cash drawer, Dr   ->  money we are holding
 *   a bank account, Cr    ->  the account is overdrawn
 *
 * Saying "owes you" against the cash drawer would be nonsense, and on a cash
 * or bank voucher the cash account is the headline figure on the page.
 *
 * Matched on the group name the same case-insensitive way `lib/cashAccount.mjs`
 * resolves a receipt's account (/^cash$/i, /^bank$/i) -- those two names are
 * fixed, see lib/customerGroups.mjs for why.
 */
export const balanceGloss = (mode, group) => {
  const g = String(group || "").trim().toLowerCase();
  if (g === "cash") return mode === "Dr" ? "in hand" : "overdrawn";
  if (g === "bank") return mode === "Dr" ? "in account" : "overdrawn";
  return mode === "Dr" ? "owes you" : "you owe";
};

/**
 * The party's city, or "" when there isn't one worth printing.
 *
 * Takes the LIVE master record for the same reason the balance does: an
 * invoice's embedded customer snapshot is only { name, phone, email, custId },
 * so reading `selectedCustomer.city` straight off would fill the city in while
 * writing a new bill and leave it blank on every saved one reopened.
 *
 * A city of "  " is nothing, not a space -- it must not render as a stray
 * separator with empty text after it.
 */
export const partyCity = (live) => String(live?.city || "").trim();
