'use client'

import { stockOf, formatQuantity } from '@/lib/itemStock.mjs'

/**
 * What is on the shelf for one item, as subtext under its name in the
 * Selected Items table.
 *
 * No item name of its own: it sits directly beneath the name cell, so
 * repeating it would just be the same word twice.
 *
 * The figure is stock BEFORE this invoice. Nothing reaches the stock ledger
 * until the invoice is saved, so the quantities on the rows above are not
 * subtracted from it -- on a sale this is what you had when you started
 * writing the bill.
 */
export default function ItemStock({ name, stock = [] }) {
  const entry = stockOf(stock, name)

  // No such item in the index at all -- say nothing rather than claim a zero.
  if (!entry) return null

  const quantity = Number(entry.quantity) || 0
  const amount = formatQuantity(Math.abs(quantity), entry.unit)

  // Negative stock is real: more has been issued than ever came in. Worth
  // showing plainly rather than clamping to zero.
  const reading =
    quantity > 0 ? `In stock: ${amount}`
    : quantity === 0 ? 'Out of stock'
    : `Short by ${amount}`

  return (
    <p
      className={
        quantity > 0
          ? 'field-hint mt-0.5 font-medium tabular-nums text-success'
          : 'field-hint mt-0.5 font-medium tabular-nums text-destructive'
      }
    >
      {reading}
    </p>
  )
}
