'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import StaffForm from '@/components/StaffForm';
import {
  ROLE_BLURBS,
  ROLE_LABELS,
  STATUS_FILTERS,
  filterStaff,
  staffSummary,
} from '@/lib/staffRules.mjs';

export const dynamic = 'force-dynamic';

/**
 * Staff Management.
 *
 * Owner-only: /staff is mapped to `user:manage` in lib/roles.mjs, so the edge
 * middleware turns an accountant or a biller away before this file is reached
 * and /api/staff refuses them again if they call it directly. Neither check is
 * in here -- a page that guards itself is guarding the wrong thing.
 *
 * THE OWNER'S OWN ROW IS SHOWN, with its controls disabled and the reason
 * beside them. Hiding owners would make a tidier page and a lying one: "2
 * staff" when three people can sign in is worse than a row that cannot be
 * edited.
 *
 * NOTHING IS DECIDED HERE. Which roles can be assigned, what may be done to a
 * given row and why not, and the three figures at the top all come from
 * lib/staffRules.mjs -- the same module the routes refuse with. The filters run
 * in the browser because a trading firm's whole staff is a handful of rows and
 * a round trip per keystroke would be slower than the typing.
 */

const DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const asDate = (value) => (value ? DATE.format(new Date(value)) : '—');

const STATUS_LABELS = { all: 'All', active: 'Active', inactive: 'Deactivated' };

export default function StaffPage() {
  const [staff, setStaff] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [search, setSearch] = useState('');
  const [role, setRole] = useState('all');
  const [status, setStatus] = useState('all');

  const [editing, setEditing] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/staff');
      const data = await res.json();
      if (!data.success) {
        setError(data.error || data.message || 'Could not load the staff list.');
        setStaff([]);
        return;
      }
      setStaff(data.staff || []);
      setMe(data.me || null);
    } catch (err) {
      setError(err.message || 'Could not load the staff list.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Counted over EVERYONE, not over what the filters left. A figure that moves
  // when you type in the search box is not a total.
  const summary = useMemo(() => staffSummary(staff), [staff]);
  const shown = useMemo(() => filterStaff({ staff, search, role, status }), [staff, search, role, status]);

  const setActive = async (person, active) => {
    setBusyId(person.id);
    setError('');
    try {
      const res = await fetch('/api/staff-status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: person.id, active }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not change the account.');
        return;
      }
      setNotice(data.message || '');
      await load();
    } catch (err) {
      setError(err.message || 'Could not change the account.');
    } finally {
      setBusyId('');
      setConfirming(null);
    }
  };

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">Staff</h1>
          <p className="page-subtitle">
            Who can sign in to this firm, and what they may do. Only you can change this.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          Add staff member
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <span>{notice}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="stat-card">
          <div className="stat-label">Total staff</div>
          <div className="stat-value">{summary.total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active</div>
          <div className="stat-value">{summary.active}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Deactivated</div>
          <div className="stat-value">{summary.inactive}</div>
        </div>
      </div>

      <div className="panel mb-4">
        <div className="panel-body grid gap-3 sm:grid-cols-3">
          <div>
            <label className="field-label" htmlFor="staff-search">Search</label>
            <input
              id="staff-search"
              className="field-input mt-1.5"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or email"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="staff-role-filter">Role</label>
            <select
              id="staff-role-filter"
              className="field-select mt-1.5"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="all">All roles</option>
              {Object.keys(ROLE_LABELS).map((key) => (
                <option key={key} value={key}>
                  {ROLE_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="staff-status-filter">Status</label>
            <select
              id="staff-status-filter"
              className="field-select mt-1.5"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS_FILTERS.map((key) => (
                <option key={key} value={key}>
                  {STATUS_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table min-w-[720px]">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Added</th>
              <th className="text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">Loading&hellip;</div>
                </td>
              </tr>
            )}

            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    {staff.length === 0
                      ? 'Nobody but you can sign in yet. Add an accountant or a biller to get started.'
                      : 'No staff match those filters.'}
                  </div>
                </td>
              </tr>
            )}

            {!loading &&
              shown.map((person) => {
                const isMe = me?.id === person.id;
                return (
                  <tr key={person.id}>
                    <td className="font-medium">
                      {person.name || '—'}
                      {isMe && <span className="field-hint block">That&rsquo;s you</span>}
                    </td>
                    <td className="break-words">{person.email}</td>
                    <td>
                      <span className="chip">{ROLE_LABELS[person.role] || person.role}</span>
                      <span className="field-hint block">{ROLE_BLURBS[person.role]}</span>
                    </td>
                    <td>
                      {person.active ? (
                        <span className="chip">Active</span>
                      ) : (
                        <span className="chip">Deactivated</span>
                      )}
                      {person.active && person.mustChangePassword && (
                        <span className="field-hint block">Has not set their own password yet</span>
                      )}
                    </td>
                    <td>{asDate(person.createdAt)}</td>
                    <td className="text-center">
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setEditing(person);
                            setFormOpen(true);
                          }}
                        >
                          Edit
                        </button>
                        {person.active ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm text-destructive hover:text-destructive"
                            disabled={!person.powers?.canDeactivate || busyId === person.id}
                            title={person.powers?.statusReason || 'Deactivate this account'}
                            onClick={() => setConfirming({ person, active: false })}
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busyId === person.id}
                            onClick={() => setConfirming({ person, active: true })}
                          >
                            Reactivate
                          </button>
                        )}
                      </div>
                      {/* The reason a control is off, rather than just a
                          greyed-out button -- the lesson from the Against Bill
                          tick, which looked broken for exactly this reason. */}
                      {person.active && person.powers?.statusReason && (
                        <span className="field-hint block">{person.powers.statusReason}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <p className="field-hint mt-4">
        Deactivating an account signs that person out straight away and blocks every page and API
        call. Their invoices, vouchers, ledger entries and stock movements are kept exactly as they
        are &mdash; nothing is deleted, which is why there is no delete button.
      </p>

      <StaffForm
        open={formOpen}
        staff={editing}
        onClose={() => setFormOpen(false)}
        onSaved={(data) => {
          setNotice(data?.message || '');
          load();
        }}
      />

      {/* Sensitive actions are confirmed, and the dialog says what will
          actually happen rather than asking "are you sure?". */}
      {confirming && (
        <div className="modal-overlay">
          <div className="modal-card max-w-md">
            <div className="modal-title">
              {confirming.active ? 'Reactivate' : 'Deactivate'} {confirming.person.name}?
            </div>
            <p className="text-sm text-muted-foreground">
              {confirming.active ? (
                <>
                  {confirming.person.name} will be able to sign in again as{' '}
                  {ROLE_LABELS[confirming.person.role] || confirming.person.role}, with the password
                  they had before.
                </>
              ) : (
                <>
                  {confirming.person.name} will be signed out immediately and will not be able to
                  open any page or make any request. Everything they have recorded stays in the
                  books. You can reactivate the account at any time.
                </>
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(null)}
                disabled={Boolean(busyId)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={confirming.active ? 'btn btn-primary' : 'btn btn-danger'}
                disabled={Boolean(busyId)}
                onClick={() => setActive(confirming.person, confirming.active)}
              >
                {busyId
                  ? 'Working…'
                  : confirming.active
                    ? 'Reactivate'
                    : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
