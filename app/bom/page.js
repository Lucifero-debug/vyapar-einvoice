'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The formula register -- Sigfa's BOMList.
 *
 * One row per bill of material: what it makes, the batch it is written for,
 * and how its lines break down. `Used` is how many production entries came
 * from it, which is the figure that makes the delete confirmation honest.
 *
 * Deliberately shows the LINE COUNTS rather than the lines. A shop with two
 * hundred formulas of a dozen lines each would otherwise download the whole
 * recipe book to draw a table of names.
 */

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

const qty = (n) => String(parseFloat((Number(n) || 0).toFixed(3)));

export default function BomRegister() {
  const router = useRouter();

  const [boms, setBoms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // The delete prompt. Deleting a formula is never refused, but it can have
  // consequences worth reading first (production entries that came from it,
  // other formulas that expand through it), so this cannot be a bare
  // window.confirm -- there would be nowhere to show them.
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/bom');
      const data = await res.json();
      if (data.success) setBoms(data.boms || []);
      else setError(data.error || 'Could not load the formulas.');
    } catch (err) {
      setError(err.message || 'Could not load the formulas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const askDelete = async (bom) => {
    // First call WITHOUT confirm: the route answers with the notices rather
    // than deleting, so the prompt can say what is about to happen.
    const res = await fetch(`/api/delete-bom?id=${encodeURIComponent(bom._id)}`, {
      method: 'POST',
    });
    const data = await res.json();

    if (data.success) {
      await load();
      return;
    }
    if (data.needsConfirm) {
      setConfirming({ bom, notices: data.notices || [] });
      return;
    }
    setError(data.error || data.message || 'Could not delete the formula.');
  };

  const doDelete = async () => {
    if (!confirming) return;
    const res = await fetch(
      `/api/delete-bom?id=${encodeURIComponent(confirming.bom._id)}&confirm=1`,
      { method: 'POST' }
    );
    const data = await res.json();
    setConfirming(null);
    if (data.success) await load();
    else setError(data.error || data.message || 'Could not delete the formula.');
  };

  const needle = search.trim().toLowerCase();
  const shown = needle
    ? boms.filter(
        (b) =>
          String(b.name || '').toLowerCase().includes(needle) ||
          String(b.outputItem || '').toLowerCase().includes(needle)
      )
    : boms;

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">Bills of Material</h1>
          <p className="page-subtitle">
            What each item is made of. Costed from the item master, so a formula always
            shows today&apos;s prices.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => router.push('/production')}
          >
            Production
          </button>
          <button type="button" className="btn btn-primary" onClick={() => router.push('/bomadd')}>
            New formula
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mb-4 max-w-sm">
        <input
          className="field-input"
          placeholder="Search by formula or item…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Formula</th>
              <th>Makes</th>
              <th className="num">For</th>
              <th className="num">Materials</th>
              <th className="num">Wastage</th>
              <th className="num">By-products</th>
              <th className="num">Used</th>
              <th>Changed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">Loading…</div>
                </td>
              </tr>
            ) : shown.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">
                    {boms.length === 0
                      ? 'No formulas yet. A formula says what one item is made of, and lets a production entry issue those materials in one go.'
                      : 'Nothing matches that search.'}
                  </div>
                </td>
              </tr>
            ) : (
              shown.map((bom) => (
                <tr key={bom._id}>
                  <td className="font-medium">
                    {bom.name}
                    {bom.hold && <span className="chip ml-2">On hold</span>}
                  </td>
                  <td>{bom.outputItem}</td>
                  <td className="num">
                    {qty(bom.forQuantity)} {bom.outputUnit}
                  </td>
                  <td className="num">{bom.materialCount}</td>
                  <td className="num">{bom.wastageCount || '—'}</td>
                  <td className="num">{bom.byproductCount || '—'}</td>
                  <td className="num">{bom.producedCount || '—'}</td>
                  <td>{asDate(bom.updatedAt)}</td>
                  <td>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => router.push(`/production?bom=${encodeURIComponent(bom.name)}`)}
                      >
                        Produce
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => router.push(`/bomadd?id=${encodeURIComponent(bom._id)}`)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => askDelete(bom)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {confirming && (
        <div className="modal-overlay">
          <div className="modal-card">
            <div className="modal-title">Delete &ldquo;{confirming.bom.name}&rdquo;?</div>
            <div className="space-y-2 py-2 text-sm">
              {confirming.notices.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(null)}
              >
                Keep it
              </button>
              <button type="button" className="btn btn-danger" onClick={doDelete}>
                Delete anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
