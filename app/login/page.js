'use client'

import React, { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  // Where they were headed before the gate sent them here.
  const next = params.get('next') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.message || 'Could not sign in.')
        return
      }
      // A full navigation, not router.push: the session cookie has just been
      // set and every page behind the gate needs the server to see it.
      window.location.assign(next)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className='panel panel-body flex flex-col gap-4'>
      <div className='space-y-1'>
        <label className='field-label' htmlFor='email'>Email</label>
        <input
          id='email'
          type='email'
          autoComplete='username'
          required
          className='field-input'
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className='space-y-1'>
        <label className='field-label' htmlFor='password'>Password</label>
        <input
          id='password'
          type='password'
          autoComplete='current-password'
          required
          className='field-input'
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && (
        <p className='text-sm text-destructive' role='alert'>{error}</p>
      )}

      <button type='submit' disabled={busy} className='btn btn-primary w-full'>
        {busy ? 'Signing in...' : 'Sign in'}
      </button>

      <p className='field-hint text-center'>
        New firm?{' '}
        <Link href='/signup' className='font-medium text-primary'>Create an account</Link>
      </p>
    </form>
  )
}

export default function LoginPage() {
  return (
    <div className='page-shell max-w-sm'>
      <header className='page-header'>
        <div>
          <h1 className='page-title'>Sign in</h1>
          <p className='page-subtitle'>Vyapaar — Billing &amp; GST</p>
        </div>
      </header>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  )
}
