/**
 * The part of saving a formula that needs the database.
 *
 * NOT pure, and one of the few modules in lib/ that is allowed not to be --
 * the same documented exception as itemLedger.mjs, runningBalances.mjs,
 * cashAccount.mjs and orderClaims.mjs. The rules themselves live in
 * lib/bom.mjs, which stays runnable under bare node; what is here is the three
 * things that need to look something up.
 *
 * It exists so `bom-add` and `bom-alter` cannot drift apart. They had every
 * reason to: the same validation, the same unit stamping and the same cycle
 * check, written twice. That is exactly how `customer-add` and
 * `customer-alter` ended up with different duplicate-name rules, so that a
 * name blocked on create could be reached by renaming (see lib/uniqueName.mjs).
 */

import Bom from "../models/bomModel";
import Item from "../models/itemModel";
import { byOutputItem, explode, lineKind, roundQty } from "./bom.mjs";

const text = (value) => String(value ?? "").trim();
const key = (value) => text(value).toLowerCase();

/** The item master, indexed by lowercased name. One query, not one per line. */
export async function loadItemIndex(session = null) {
  const opts = session ? { session } : {};
  const items = await Item.find({}, { name: 1, unit: 1, cost: 1 }, opts).lean();
  return new Map(items.map((item) => [key(item.name), item]));
}

/**
 * Clean the submitted lines, and stamp the unit from the item master.
 *
 * The unit is NOT taken from the form. Same reasoning as `stampItemLines` in
 * lib/uqc.mjs: a page can send a stale or hand-edited value, and a unit that
 * disagrees with the master makes a printed formula say one thing while the
 * stock report says another.
 *
 * Returns { lines, unknown } -- `unknown` naming items that are not in the
 * master at all, which the caller refuses. A line naming an item that does not
 * exist would issue stock against a name with no master behind it, and the
 * stock report then counts its opening quantity as zero.
 */
export function stampBomLines(submitted = [], itemIndex = new Map()) {
  const lines = [];
  const unknown = [];

  for (const line of submitted) {
    const itemName = text(line?.itemName ?? line?.name);
    if (!itemName) continue;

    const master = itemIndex.get(key(itemName));
    if (!master) {
      if (!unknown.includes(itemName)) unknown.push(itemName);
      continue;
    }

    lines.push({
      // The master's own spelling, so two formulas never disagree about
      // whether it is "MS Sheet" or "ms sheet".
      itemName: text(master.name),
      kind: lineKind(line?.kind),
      quantity: roundQty(line?.quantity),
      unit: text(master.unit),
      note: text(line?.note),
    });
  }

  return { lines, unknown };
}

/**
 * Would saving this formula create a loop?
 *
 * `bomProblems` catches an item made of itself, which is the one-step case and
 * the only one visible from a single document. A loop across two or three
 * formulas (A made of B made of A) is only visible once they are read
 * together, and nothing stops a user creating them one at a time -- each save
 * looks innocent.
 *
 * Checked by exploding the CANDIDATE against the rest of the book with itself
 * substituted in. Any cycle that includes the candidate is reachable by
 * walking down from it, so this one explosion is enough; a cycle that does not
 * include it is not something this save created.
 *
 * Returns the loop description, or null.
 */
export async function loopFromSaving(candidate, { excludeId, session } = {}) {
  const opts = session ? { session } : {};

  const others = await Bom.find(
    excludeId ? { _id: { $ne: excludeId } } : {},
    { name: 1, outputItem: 1, forQuantity: 1, lines: 1 },
    opts
  ).lean();

  // The candidate must be IN the index as well as the thing being exploded:
  // without it, a formula two levels down that consumes the candidate's
  // output would find nothing there and the loop would stay invisible.
  const index = byOutputItem([...others, candidate]);

  const { warnings } = explode({
    bom: candidate,
    // Its own batch size. Any positive quantity finds the same loop; this one
    // is guaranteed positive because bomProblems has already refused a
    // formula that makes nothing.
    outputQuantity: candidate?.forQuantity || 1,
    index,
  });

  return warnings.find((w) => /loops back on itself/.test(w)) || null;
}
