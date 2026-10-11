'use client';
import React, { useEffect, useState } from 'react';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '@/lib/passwordRules.mjs';

export const dynamic = 'force-dynamic';

/**
 * Setting your own password.
 *
 * Two jobs, one screen: the forced first change after an owner has created the
 * account, and an ordinary change any time afterwards. Which one it is comes
 * from /api/auth/me, not from a query string -- a flag in the URL would let
 * somebody dismiss the forced version by editing the address bar.
 *
 * This page is NOT the lock. `requireAuth` in lib/authServer.mjs refuses every
 * route but four while `mustChangePassword` is set, so a staff member who
 * never comes here simply cannot work. This is the place to go, not the thing
 * stopping them.
 *
 * Changing a password bumps `tokenVersion`, which ends this session too, so it
 * finishes at the sign-in page rather than pretending to carry on.
 */

export default function ChangePasswordPage() {
  const [me, setMe] = useState(null);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setMe(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const forced = me?.user?.mustChangePassword === true;
  const set = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const problem =
    passwordProblem(form.newPassword) ||
    (form.newPassword && form.confirm !== form.newPassword
      ? 'The two new passwords do not match.'
      : null);

  const submit = async (e) => {
    e.preventDefault();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: form.currentPassword,
          newPassword: form.newPassword,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || data.message || 'Could not change the password.');
        return;
      }
      setDone(true);
      // The bump has already invalidated this session, so there is nothing to
      // stay signed in to. Full navigation, so the gate sees the dead cookie.
      setTimeout(() => window.location.assign('/login'), 1200);
    } catch (err) {
      setError(err.message || 'Could not change the password.');
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div className="page-shell">
        <div className="panel">
          <div className="panel-body">
            <h1 className="page-title">Password changed</h1>
            <p className="page-subtitle">Taking you to the sign-in page&hellip;</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">{forced ? 'Set your own password' : 'Change your password'}</h1>
          <p className="page-subtitle">
            {forced
              ? 'Your firm set a password for you. Replace it with one only you know before you carry on.'
              : 'You will be signed out of every device once it changes.'}
          </p>
        </div>
      </div>

      {forced && (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          Nothing else in the app will open until this is done.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form className="panel max-w-md" onSubmit={submit}>
        <div className="panel-body space-y-4">
          <div>
            <label className="field-label" htmlFor="current">
              {forced ? 'The password you were given' : 'Current password'}
            </label>
            <input
              id="current"
              type="password"
              className="field-input mt-1.5"
              value={form.currentPassword}
              onChange={set('currentPassword')}
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="next">New password</label>
            <input
              id="next"
              type="password"
              className="field-input mt-1.5"
              value={form.newPassword}
              onChange={set('newPassword')}
              autoComplete="new-password"
            />
            <p className="field-hint mt-1">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>
          <div>
            <label className="field-label" htmlFor="confirm">New password again</label>
            <input
              id="confirm"
              type="password"
              className="field-input mt-1.5"
              value={form.confirm}
              onChange={set('confirm')}
              autoComplete="new-password"
            />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={saving}>
            {saving ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}
