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
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState('')

  useEffect(() => {
    let cancelled = false
    const here = window.location.pathname

    fetch('/api/auth/me')
      .then(async (res) => {
        if (cancelled) return

        // === A session that has died while a page was open ===
        //
        // This is the only place the browser finds out. middleware.js runs at
        // the edge with no database, so it can only check the signature: a
        // staff member deactivated a minute ago still gets the page shell,
        // and every request on it fails. Rendering nothing -- what this did
        // before -- left them sitting on a dead page wondering why no button
        // worked.
        if (res.status === 401) {
          if (here !== '/login') window.location.assign('/login')
          return
        }

        const data = res.ok ? await res.json() : null
        if (cancelled || !data?.success) return

        // An owner-set password that has not been replaced. requireAuth is
        // already refusing every other route, so sending them here is what
        // turns a wall of 403s into the one screen that works.
        if (data.user?.mustChangePassword && here !== '/change-password') {
          window.location.assign('/change-password')
          return
        }

        setMe(data)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!me) return null

  const signOut = async () => {
    setSigningOut(true)
    setSignOutError('')
    // Only the server can clear the session cookie (it is httpOnly). The
    // failure used to be swallowed and the page sent to /login anyway --
    // where the gate, still seeing a valid session, sent it straight back
    // home: a sign-out that silently did nothing, on a shared counter PC.
    const res = await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
    if (!res || !res.ok) {
      setSigningOut(false)
      setSignOutError(res ? 'Not signed out -- the server refused. Try again.' : 'Not signed out -- the server could not be reached. Check the connection and try again.')
      return
    }
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
          <a href='/change-password' className='btn btn-secondary btn-sm mt-3 w-full'>
            Change password
          </a>
          <button
            type='button'
            onClick={signOut}
            disabled={signingOut}
            className='btn btn-secondary btn-sm mt-2 w-full'
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          {signOutError && (
            <p className='field-hint mt-2 text-destructive' role='alert'>{signOutError}</p>
          )}
        </div>
      )}
    </div>
  )
}
