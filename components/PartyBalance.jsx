'use client'

import { toDisplay } from '@/lib/balance.mjs'
import { formatINR } from '@/lib/currency.mjs'
import { livePartyFor, balanceGloss, partyCity } from '@/lib/partyBalance.mjs'

/**
 * Resolve a selection to what should appear on screen, or null when there is
 * nothing honest to show.
 *
 * Kept apart from the markup so the resolving rules stay readable on their own.
 */
const readParty = (selected, customers) => {
  const live = livePartyFor(selected, customers)

  // Nothing selected, or a party that is on an old document but no longer in
  // the master. Show nothing rather than a confident zero.
  if (!live) return null

  const { amount, mode } = toDisplay(live.lastBal)
  return {
    city: partyCity(live),
    settled: amount === 0,
    text: `${formatINR(amount)} ${mode}`,
    gloss: balanceGloss(mode, live.group),
    // Dr reads positive, Cr reads negative -- the same semantics as the
    // .money-dr / .money-cr classes the ledger uses.
    tone: mode === 'Dr' ? 'text-success' : 'text-destructive',
  }
}

/**
 * Who the party is and where they stand, as one line under a customer picker,
 * so whoever is writing the document can confirm they picked the right party
 * and see what is already outstanding without leaving the screen.
 *
 *   Ludhiana · Current balance: Rs 1,500.00 Dr (owes you)
 *
 * The city is there because trading names repeat across towns -- two parties
 * called "Sharma Traders" are told apart by where they are, not by the name in
 * the dropdown.
 *
 * The balance is the party's CURRENT one: on a new document that is the
 * position BEFORE it, and on one being edited it already includes that
 * document's own posting.
 *
 * Dr/Cr is read off the SIGN of `lastBal` via toDisplay(), never off the
 * `lastMode` cache, which is the field that drifts.
 */
export default function PartyBalance({ selected, customers = [] }) {
  const party = readParty(selected, customers)
  if (!party) return null

  return (
    <p className='field-hint mt-1'>
      {party.city && (
        <>
          <span className='font-medium text-foreground'>{party.city}</span>
          {' · '}
        </>
      )}
      Current balance:{' '}
      {party.settled ? (
        'settled'
      ) : (
        <>
          <span className={`font-medium tabular-nums ${party.tone}`}>
            {party.text}
          </span>{' '}
          ({party.gloss})
        </>
      )}
    </p>
  )
}
