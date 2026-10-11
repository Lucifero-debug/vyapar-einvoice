'use client';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ASSIGNABLE_ROLES,
  ROLE_BLURBS,
  ROLE_LABELS,
  emailProblem,
  nameProblem,
  staffCreateProblems,
} from '@/lib/staffRules.mjs';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '@/lib/passwordRules.mjs';

/**
 * Adding a staff member, or editing one.
 *
 * ONLY TWO ROLES ARE OFFERED, and not because the dropdown is short: the
 * options come from ASSIGNABLE_ROLES in lib/staffRules.mjs, the same list the
 * server validates against. A hand-written `<option value="owner">` could not
 * get past the route, but it also could not get past review -- there is one
 * place that decides, and this reads it.
 *
 * PASSWORD RULES come from lib/passwordRules.mjs, which exists precisely so a
 * client component can import them: lib/password.mjs pulls in node:crypto and
 * dragging that into the browser bundle used to break the build.
 *
 * The checks here are the same functions the route runs. They say why before
 * the save does, not instead of it.
 */

export default function StaffForm({ open, staff, onClose, onSaved }) {
  const editing = Boolean(staff?.id);

  const [form, setForm] = useState({ name: '', email: '', role: 'biller', password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setTouched(false);
    setForm({
      name: staff?.name || '',
      email: staff?.email || '',
      // An owner being edited keeps their role in the box, disabled below:
      // showing "Biller" against the owner's row would be a lie on screen.
      role: staff?.role || 'biller',
      password: '',
    });
  }, [open, staff]);

  const set = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  /**
   * What is wrong, from the same module the server uses.
   *
   * On an edit the password is optional -- blank means "leave it alone" -- so
   * it is only checked when something has been typed. On a create it is
   * required, which is what staffCreateProblems already says.
   */
  const problems = useMemo(() => {
    if (!editing) return staffCreateProblems(form);
    const found = [];
    const badName = nameProblem(form.name);
    if (badName) found.push(badName);
    const badEmail = emailProblem(form.email);
    if (badEmail) found.push(badEmail);
    if (form.password) {
      const badPassword = passwordProblem(form.password);
      if (badPassword) found.push(badPassword);
    }
    return found;
  }, [editing, form]);

  const roleLocked = editing && staff?.role === 'owner';
  const roleBlocked = editing && staff?.powers?.canChangeRole === false;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (problems.length) return;

    setSaving(true);
    setError('');
    try {
      const url = editing ? '/api/staff-alter' : '/api/staff-add';
      const payload = editing
        ? {
            id: staff.id,
            name: form.name,
            email: form.email,
            // Left out entirely when it cannot change, so the route is not
            // asked to refuse something the screen already knows about.
            ...(roleLocked || roleBlocked ? {} : { role: form.role }),
            ...(form.password ? { password: form.password } : {}),
          }
        : { name: form.name, email: form.email, role: form.role, password: form.password };

      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error || 'Could not save.');
        return;
      }
      onSaved?.(data);
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay">
      <form className="modal-card max-w-lg" onSubmit={submit}>
        <div className="modal-title">
          {editing ? `Edit ${staff?.name || 'staff member'}` : 'Add a staff member'}
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="field-label" htmlFor="staff-name">Name</label>
            <input
              id="staff-name"
              className="field-input mt-1.5"
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. Ravi Kumar"
              autoComplete="off"
            />
          </div>

          <div>
            <label className="field-label" htmlFor="staff-email">Email</label>
            <input
              id="staff-email"
              type="email"
              className="field-input mt-1.5"
              value={form.email}
              onChange={set('email')}
              placeholder="ravi@yourfirm.com"
              autoComplete="off"
            />
            <p className="field-hint mt-1">They sign in with this.</p>
          </div>

          <div>
            <label className="field-label" htmlFor="staff-role">Role</label>
            <select
              id="staff-role"
              className="field-select mt-1.5"
              value={form.role}
              onChange={set('role')}
              disabled={roleLocked || roleBlocked}
            >
              {/* An owner's own role is shown so the row does not misreport
                  itself, but it is not in the assignable list and cannot be
                  chosen for anybody else. */}
              {roleLocked && <option value="owner">{ROLE_LABELS.owner}</option>}
              {ASSIGNABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
            <p className="field-hint mt-1">
              {roleLocked
                ? 'An owner’s role cannot be changed here.'
                : roleBlocked
                  ? staff?.powers?.roleReason
                  : ROLE_BLURBS[form.role]}
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor="staff-password">
              {editing ? 'New password' : 'Initial password'}
            </label>
            <input
              id="staff-password"
              type="password"
              className="field-input mt-1.5"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              placeholder={editing ? 'Leave blank to keep the current one' : ''}
            />
            <p className="field-hint mt-1">
              At least {MIN_PASSWORD_LENGTH} characters. Read it out to them &mdash; they will be
              asked to set their own before they can do anything else, so this one stops working.
            </p>
          </div>
        </div>

        {touched && problems.length > 0 && (
          <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <ul className="list-inside list-disc space-y-1">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => onClose?.()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add staff member'}
          </button>
        </div>
      </form>
    </div>
  );
}
