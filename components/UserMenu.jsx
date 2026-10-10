'use client'

import { useEffect, useState } from 'react'

/**
 * Who is signed in, which firm, and the way out.
 *
 * Asks /api/auth/me rather than taking anything from the cookie: the cookie is
 * httpOnly and unreadable here by design, and the answer is checked against
 * the database, so a revoked session shows as signed out rather than as a
 * stale name in the corner.
 *
 * Renders nothing on the sign-in pages, and nothing until the answer arrives,
 * so the header does not flicker between states on every page load.
 */
export default function UserMenu() {
  const [me, setMe] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data?.success) setMe(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!me) return null

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    // Full navigation: the gate has to see the cleared cookie.
    window.location.assign('/login')
  }

  const initials = (me.user?.name || me.user?.email || '?')
    .trim()
    .slice(0, 1)
    .toUpperCase()

  return (
    <div className='relative'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-foreground'
        aria-haspopup='menu'
        aria-expanded={open}
        title={me.user?.email || ''}
      >
        {initials}
      </button>

      {open && (
        <div
          role='menu'
          className='absolute right-0 z-50 mt-2 w-56 rounded-lg border border-border bg-card p-3 shadow-lg'
        >
          <p className='text-sm font-medium text-foreground'>{me.company?.name}</p>
          <p className='field-hint break-words'>{me.user?.email}</p>
          <p className='field-hint mt-1 capitalize'>{me.user?.role}</p>
          <button
            type='button'
            onClick={signOut}
            className='btn btn-secondary btn-sm mt-3 w-full'
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
