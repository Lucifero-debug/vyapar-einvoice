'use client'

import React, { useState } from 'react'
import Link from 'next/link'
// From passwordRules, not password.mjs: that one imports node:crypto and
// this is a client component, so the import has to stay browser-safe.
import { MIN_PASSWORD_LENGTH } from '@/lib/passwordRules.mjs'

/**
 * First run for a firm: creates the company and its owner together.
 *
 * MIN_PASSWORD_LENGTH comes from the same module the server checks against, so
 * the hint on screen cannot drift from the rule that actually applies.
 */
export default function SignupPage() {
  const [form, setForm] = useState({ companyName: '', name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.message || 'Could not create the account.')
        return
      }
      window.location.assign('/')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='page-shell max-w-sm'>
      <header className='page-header'>
        <div>
          <h1 className='page-title'>Create your firm</h1>
          <p className='page-subtitle'>You will be its owner.</p>
        </div>
      </header>

      <form onSubmit={submit} className='panel panel-body flex flex-col gap-4'>
        <div className='space-y-1'>
          <label className='field-label' htmlFor='companyName'>Firm name</label>
          <input id='companyName' type='text' required className='field-input'
            value={form.companyName} onChange={set('companyName')} />
          <p className='field-hint'>This is what prints on your invoices.</p>
        </div>

        <div className='space-y-1'>
          <label className='field-label' htmlFor='name'>Your name</label>
          <input id='name' type='text' className='field-input'
            value={form.name} onChange={set('name')} />
        </div>

        <div className='space-y-1'>
          <label className='field-label' htmlFor='email'>Email</label>
          <input id='email' type='email' autoComplete='username' required className='field-input'
            value={form.email} onChange={set('email')} />
        </div>

        <div className='space-y-1'>
          <label className='field-label' htmlFor='password'>Password</label>
          <input id='password' type='password' autoComplete='new-password' required
            minLength={MIN_PASSWORD_LENGTH} className='field-input'
            value={form.password} onChange={set('password')} />
          <p className='field-hint'>At least {MIN_PASSWORD_LENGTH} characters.</p>
        </div>

        {error && <p className='text-sm text-destructive' role='alert'>{error}</p>}

        <button type='submit' disabled={busy} className='btn btn-primary w-full'>
          {busy ? 'Creating...' : 'Create firm'}
        </button>

        <p className='field-hint text-center'>
          Already have an account?{' '}
          <Link href='/login' className='font-medium text-primary'>Sign in</Link>
        </p>
      </form>
    </div>
  )
}
