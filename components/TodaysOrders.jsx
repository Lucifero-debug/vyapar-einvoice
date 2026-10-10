'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { formatINR } from '@/lib/currency.mjs'
import { dismissKey, headline, shouldShow } from '@/lib/todaysOrders.mjs'

/**
 * "You have orders dated today" — once each morning, then it leaves you alone.
 *
 * `orderDate` is typed on the billing form and was never shown again, so a
 * bill raised against an order dated today disappeared the moment it was
 * saved. This is the one place the app brings it back.
 *
 * Mounted in the root layout, so it can appear on whichever page is opened
 * first. Dismissing writes today's IST day into localStorage, so tomorrow is a
 * different key and needs no cleanup. Per browser, deliberately: it is a nudge,
 * not a task list that has to be ticked off exactly once.
 *
 * Every storage call is wrapped, because a private window throws on
 * localStorage and a reminder must never be able to take a page down.
 */
export default function TodaysOrders() {
  const pathname = usePathname()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)

  // Not on the sign-in pages: nobody is signed in, the request would 401, and
  // a popup over a login form is nonsense.
  const isPublic = pathname === '/login' || pathname === '/signup'

  useEffect(() => {
    if (isPublic) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch('/api/todays-orders', { cache: 'no-store' })
        if (!res.ok) return
        const body = await res.json()
        if (cancelled || !body?.success) return

        const show = shouldShow({
          count: body.count,
          read: (key) => window.localStorage.getItem(key),
        })
        if (!show) return

        setData(body)
        setOpen(true)
      } catch (err) {
        // Offline, or the navigation cancelled it. A reminder that cannot load
        // is not worth a word on screen.
        console.error("Could not check today's orders:", err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isPublic])

  const dismiss = () => {
    setOpen(false)
    try {
      const key = dismissKey()
      if (key) window.localStorage.setItem(key, '1')
    } catch (err) {
      // Nothing to do. It will appear once more on the next load, which is
      // the harmless direction to fail in.
    }
  }

  if (!open || !data?.count) return null

  return (
    <div className='modal-overlay no-print' role='dialog' aria-modal='true' aria-labelledby='todays-orders-title'>
      <div className='modal-card max-w-lg'>
        <h2 className='modal-title mb-1' id='todays-orders-title'>
          {headline(data.count)}
        </h2>
        <p className='field-hint mb-3'>
          Raised against an order dated today. Open one to check it.
        </p>

        <ul className='flex flex-col gap-1'>
          {data.orders.map((o) => (
            <li key={`${o.type}-${o.invoiceNo}`}>
              <Link
                href={`/invoice?invoiceNo=${o.invoiceNo}`}
                onClick={dismiss}
                className='flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:border-primary/40 hover:bg-accent/40'
              >
                <span className='min-w-0'>
                  <span className='block truncate text-sm font-medium text-foreground'>
                    {o.party}
                  </span>
                  <span className='field-hint'>
                    {o.type} {o.invoiceNo}
                    {o.orderNo ? ` · order ${o.orderNo}` : ''}
                  </span>
                </span>
                <span className='shrink-0 text-sm font-medium tabular-nums text-foreground'>
                  {formatINR(o.amount)}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {data.more > 0 && (
          <p className='field-hint mt-2'>and {data.more} more</p>
        )}

        <div className='mt-4 flex justify-end'>
          <button onClick={dismiss} className='btn btn-secondary'>
            Dismiss for today
          </button>
        </div>
      </div>
    </div>
  )
}
