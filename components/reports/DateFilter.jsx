'use client';

/**
 * The date filter every report shares.
 *
 * All thirteen presets from lib/reportPeriods.mjs, grouped the way a person
 * thinks about periods, plus the two boxes for a custom range. The component
 * holds NO period logic of its own: it reports a preset (and, for Custom, two
 * dates) upward, and the resolving is done by `resolvePeriod` -- on the server
 * for the query and here only to show what the chosen period comes out as.
 *
 * That split is deliberate. A component that worked out its own month ends
 * would be a second resolver, and two resolvers are how one screen's March
 * ends on the 31st and another's on the 30th.
 *
 *
 * WHY THE PRESET STAYS SELECTED AFTER A CUSTOM EDIT
 * ------------------------------------------------
 * Typing in either date box switches the preset to Custom, because the dates
 * no longer describe the preset. The reverse does not happen: choosing a
 * preset leaves whatever was typed in the boxes alone, so a person who tries
 * This month, glances at it and goes back to their own dates still has them.
 */

import React from 'react';
import {
  PRESET_GROUPS,
  PRESET_LABELS,
  periodProblem,
  periodText,
  resolvePeriod,
} from '@/lib/reportPeriods.mjs';

export default function DateFilter({
  preset = 'thisMonth',
  from = '',
  to = '',
  onChange,
  // A report may offer fewer than all thirteen -- a day book has no use for
  // "This financial year". Given as a list of preset keys; omitted means all.
  presets = null,
  // Shown under the chips. The caller passes its own when it has something
  // more specific to say (a row count, say).
  note = '',
  disabled = false,
  idPrefix = 'df',
}) {
  const allowed = presets && presets.length ? presets : null;
  const groups = PRESET_GROUPS.map((group) => ({
    ...group,
    keys: group.keys.filter((key) => !allowed || allowed.includes(key)),
  })).filter((group) => group.keys.length);

  // What the chosen filter actually resolves to, for the line under the
  // chips. Resolved on the client purely to SHOW it; the figures come from
  // the server's own resolution of the same preset.
  const resolved = resolvePeriod({ preset, from, to });
  const problem = periodProblem({ from: resolved.from, to: resolved.to });

  const pick = (key) => {
    if (disabled) return;
    // Custom keeps whatever is in the boxes; every other preset computes its
    // own dates, and they are sent upward so the caller can put them in the
    // URL and the export without resolving anything itself.
    const next = resolvePeriod({ preset: key, from, to });
    onChange?.({ preset: key, from: next.from, to: next.to });
  };

  const editDate = (which) => (event) => {
    const value = event.target.value;
    const nextFrom = which === 'from' ? value : resolved.from;
    const nextTo = which === 'to' ? value : resolved.to;
    // Any hand-edit is a custom range by definition.
    onChange?.({ preset: 'custom', from: nextFrom, to: nextTo });
  };

  return (
    <div className="no-print">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {groups.map((group) => (
          <div key={group.label || 'other'} className="flex flex-wrap items-center gap-1.5">
            {group.label && (
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {group.label}
              </span>
            )}
            {group.keys.map((key) => (
              <button
                key={key}
                type="button"
                disabled={disabled}
                aria-pressed={preset === key}
                className={`btn btn-sm ${preset === key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => pick(key)}
              >
                {PRESET_LABELS[key]}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[repeat(2,minmax(0,12rem))_1fr] sm:items-end">
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-from`}>
            From
          </label>
          <input
            id={`${idPrefix}-from`}
            type="date"
            className="field-input mt-1.5"
            value={resolved.from}
            disabled={disabled}
            onChange={editDate('from')}
          />
        </div>
        <div>
          <label className="field-label" htmlFor={`${idPrefix}-to`}>
            To
          </label>
          <input
            id={`${idPrefix}-to`}
            type="date"
            className="field-input mt-1.5"
            value={resolved.to}
            disabled={disabled}
            onChange={editDate('to')}
          />
        </div>
        <p className="field-hint sm:pb-2">
          {/* The resolved window in words, always -- a chip that says "This
              quarter" without saying which three months is a filter the
              reader cannot check. */}
          <span className="font-medium text-foreground">{resolved.label}</span>
          {' · '}
          {periodText(resolved.from, resolved.to)}
          {problem && (
            <>
              {' · '}
              <span className="text-destructive">{problem}</span>
            </>
          )}
          {!problem && note ? ` · ${note}` : ''}
        </p>
      </div>
    </div>
  );
}
