'use client';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * Picking an item by typing, instead of hunting a dropdown.
 *
 * Sigfa's F2 "Item Search". It replaces a native `<select>` that listed the
 * entire item master in master order -- fine with forty items, unusable with
 * four hundred, and it forced the mouse for every line of every bill.
 *
 * NO NEW ENDPOINT, AND NO DEBOUNCE. /api/get-item already does `find({})`, so
 * the whole item master is in the browser before this renders. Searching an
 * array that is already in memory needs no request, which also means no
 * spinner, no race between keystrokes, and nothing to debounce. The brief
 * asked to reuse loaded data where safe; here it is not merely safe, it is
 * the only sensible reading.
 *
 * WHAT IT SEARCHES: name, `short` (the item master's short code -- Sigfa's,
 * and what this project has instead of a barcode field; there is no barcode
 * column to read, so inventing one was not an option) and `hsn`. A code match
 * sorts above a name match, and a prefix above a substring, because somebody
 * typing a code knows exactly what they want.
 *
 * ACCESSIBILITY is the standard combobox pattern rather than a homemade one:
 * role="combobox" on the input with aria-expanded and aria-activedescendant,
 * role="listbox" on the list, role="option" with aria-selected on each row.
 * Arrow keys move, Enter picks, Escape closes, Tab leaves. No positive
 * tabIndex anywhere. The highlighted row is marked by a border and a label,
 * not by colour alone.
 */

const fold = (value) => String(value ?? '').trim().toLowerCase();

/**
 * How well this item matches, or null. Lower is better.
 *
 * Exported for the test: the ranking is the whole value of the search, and a
 * component is an awkward place to assert it from.
 */
export const matchRank = (item, query) => {
  const q = fold(query);
  if (!q) return 0;

  const name = fold(item?.name);
  const short = fold(item?.short);
  const hsn = fold(item?.hsn);

  if (short && short === q) return 0;          // exact code: certainly this one
  if (short && short.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (hsn && hsn.startsWith(q)) return 3;
  if (name.includes(q)) return 4;
  if (short && short.includes(q)) return 5;
  return null;
};

/** The matching items, best first, capped so the list stays readable. */
export const searchItems = (items, query, limit = 12) =>
  (items || [])
    .map((item) => ({ item, rank: matchRank(item, query) }))
    .filter((row) => row.rank !== null)
    .sort((a, b) => a.rank - b.rank || fold(a.item?.name).localeCompare(fold(b.item?.name)))
    .slice(0, limit)
    .map((row) => row.item);

export default function ItemSearch({
  items,
  onPick,
  priceOf,
  stockOf,
  label = 'Add Item',
  inputRef,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const ownRef = useRef(null);
  const box = inputRef ?? ownRef;

  const matches = useMemo(() => searchItems(items, query), [items, query]);

  // Keep the highlight inside the list as it shortens under typing.
  useEffect(() => {
    setActive((current) => (current >= matches.length ? 0 : current));
  }, [matches.length]);

  const choose = (item) => {
    if (!item) return;
    onPick?.(item);
    // Cleared so the next item can be typed straight away -- the point of the
    // whole control is that a clerk adds ten lines without reaching for the
    // mouse once.
    setQuery('');
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      // ALWAYS prevented, whether or not anything is highlighted. Enter in
      // this box must never reach the form: it would post the invoice.
      event.preventDefault();
      if (open && matches[active]) choose(matches[active]);
      return;
    }
    if (event.key === 'Escape') {
      // Only swallowed when there is a list to close, so Escape still
      // reaches the screen's own handler otherwise.
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    // Tab is left alone, deliberately: leaving the box by Tab is the
    // browser's job and overriding it is how focus order stops making sense.
  };

  const activeId = matches.length ? `${listId}-opt-${active}` : undefined;

  return (
    <div className="relative flex flex-col">
      <label className="field-label mb-1" htmlFor={`${listId}-input`}>
        {label}
      </label>
      <input
        id={`${listId}-input`}
        ref={box}
        type="text"
        className="field-input"
        value={query}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={`${listId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open ? activeId : undefined}
        autoComplete="off"
        placeholder="Name, code or HSN"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => query && setOpen(true)}
        // A click elsewhere closes the list, but not before the click has
        // landed -- hence the delay rather than an immediate close.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      <p className="field-hint mt-1">
        Press F2 to come back here. Enter adds the highlighted item and moves to its quantity.
      </p>

      {open && matches.length > 0 && (
        <ul
          id={`${listId}-list`}
          role="listbox"
          aria-label="Matching items"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-card shadow-lg"
        >
          {matches.map((item, index) => {
            const chosen = index === active;
            const stock = stockOf?.(item);
            const price = priceOf?.(item);
            return (
              <li
                key={item._id || item.id || item.name}
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={chosen}
                // Not colour alone: the highlighted row carries a border and
                // a caret as well as a background.
                className={`flex cursor-pointer items-baseline gap-2 border-l-2 px-3 py-2 text-sm ${
                  chosen ? 'border-l-primary bg-secondary font-medium' : 'border-l-transparent'
                }`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(item)}
              >
                <span aria-hidden="true" className="w-3 text-muted-foreground">
                  {chosen ? '›' : ''}
                </span>
                <span className="flex-1">
                  {item.name}
                  {item.short && <span className="field-hint ml-2">{item.short}</span>}
                </span>
                {item.unit && <span className="field-hint">{item.unit}</span>}
                {Number.isFinite(stock) && (
                  <span className="num field-hint" title="Stock in hand">
                    {stock}
                  </span>
                )}
                {Number.isFinite(price) && <span className="num">{price}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {open && query && matches.length === 0 && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
          Nothing matches &ldquo;{query}&rdquo;. Press Alt+A to add it to the item master.
        </div>
      )}
    </div>
  );
}
