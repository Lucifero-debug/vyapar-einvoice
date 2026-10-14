'use client';
import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Picking an item: a dropdown you can also type into.
 *
 * Sigfa's F2 "Item Search", grown into the one item control the whole app
 * uses. It began as a replacement for a native `<select>` that listed the
 * entire item master in master order -- fine with forty items, unusable with
 * four hundred, and it forced the mouse for every line of every bill.
 *
 * A DROPDOWN FIRST, A SEARCH SECOND. The search-only version had one real
 * fault: it looked like a text box and showed nothing at all until you typed,
 * so there was no way to SEE what the master holds -- the thing a dropdown is
 * for. So it carries a chevron, and clicking it (or focusing the box) opens
 * the full list, scrolled to whatever is already chosen. Typing then narrows
 * it. Nobody has to know the name of an item to find it, and nobody has to
 * scroll four hundred rows to pick one they can spell.
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
 * role="listbox" on the list, role="option" with aria-selected on each row,
 * and the chevron is a real button that is kept out of the tab order (the
 * input it belongs to is already there). Arrow keys move, Enter picks, Escape
 * closes, Tab leaves. No positive tabIndex anywhere. The highlighted row is
 * marked by a border and a label, not by colour alone.
 *
 *
 * ONE CONTROL, EVERY SCREEN THAT PICKS AN ITEM
 * --------------------------------------------
 * The app had grown three different ways to choose an item -- this search, a
 * `<select>` of the whole master on the order and challan screens, and an
 * `<input list>` with a `<datalist>` on the BOM and price-list grids -- so the
 * same job was learnt three times and the datalist, which silently accepts a
 * name matching nothing, was the one guarding the two screens that write to
 * masters.
 *
 * Two shapes, because a labelled form field and a cell in a row grid are
 * genuinely different, and everything below the input is what differs:
 *
 *   variant="field"  a labelled field with a hint under it (the default, so
 *                    the billing and production screens are untouched). The
 *                    list is positioned against this component's own box.
 *   variant="cell"   a bare input for a `<td>`: no label, no hint, and the
 *                    list is PORTALLED and positioned from the input's
 *                    bounding rect. A row grid sits inside `overflow-auto`,
 *                    which clips an absolutely positioned dropdown -- the
 *                    list would be cut off at the edge of the scroll box,
 *                    which is the whole reason for the portal rather than a
 *                    nicety.
 *
 * CONTROLLED OR NOT. Pass `value` and the input shows it: picking an item
 * leaves the name in the box, which is what a draft line or a grid cell
 * needs, since the chosen name is the caller's state and is read back when
 * the line is added. Leave `value` out and the box CLEARS on every pick,
 * which is what the billing screen needs -- there, picking adds the line
 * outright and the clerk types the next item straight away.
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

/**
 * How many rows the two modes show.
 *
 * Typing is a shortlist -- twelve is already more than anybody reads before
 * refining. Browsing is the dropdown, so it shows the master and scrolls,
 * which is what somebody who clicked the chevron came for. The cap is there
 * only to keep a firm with thousands of items from laying out every row.
 */
export const TYPED_LIMIT = 12;
export const BROWSE_LIMIT = 300;

/** What the field variant says under the box, on the screens that have F2. */
const FIELD_HINT =
  'Press F2 to come back here. Enter adds the highlighted item and moves to its quantity.';

/** Roughly how tall the list wants to be, for deciding which way to open. */
const LIST_HEIGHT = 240;

export default function ItemSearch({
  items,
  onPick,
  priceOf,
  stockOf,
  label = 'Add Item',
  inputRef,
  variant = 'field',
  /** Controlled text. Omit for the billing screen's clear-on-pick box. */
  value,
  /** Typing, when controlled. */
  onQueryChange,
  /**
   * Enter with nothing highlighted. The cell variant's caller uses it to move
   * down the column, because Enter is ALWAYS prevented here -- see onKeyDown.
   */
  onEnter,
  hint,
  emptyHint = 'Press Alt+A to add it to the item master.',
  placeholder = 'Pick, or type a name, code or HSN',
  className = '',
  inputClassName,
  /** Extra attributes for the input, e.g. the grids' own `data-cell`. */
  inputProps,
}) {
  const cell = variant === 'cell';
  const controlled = value !== undefined;

  const [ownQuery, setOwnQuery] = useState('');
  const query = controlled ? value ?? '' : ownQuery;
  const setQuery = (text) => {
    if (controlled) onQueryChange?.(text);
    else setOwnQuery(text);
  };

  const [open, setOpen] = useState(false);
  /**
   * Opened to LOOK rather than to search, so the list ignores whatever is in
   * the box and shows the master. Without this, opening a box that already
   * holds "Bracket 50x50" would offer exactly one row -- the item already
   * chosen -- and there would be no way to change your mind with the mouse.
   */
  const [browsing, setBrowsing] = useState(false);
  const [active, setActive] = useState(0);
  const [at, setAt] = useState(null);
  const listId = useId();
  const ownRef = useRef(null);
  const box = inputRef ?? ownRef;

  const matches = useMemo(
    () =>
      browsing
        ? searchItems(items, '', BROWSE_LIMIT)
        : searchItems(items, query, TYPED_LIMIT),
    [items, query, browsing]
  );
  const showing = open && matches.length > 0;

  // Keep the highlight inside the list as it shortens under typing.
  useEffect(() => {
    setActive((current) => (current >= matches.length ? 0 : current));
  }, [matches.length]);

  /**
   * Keep the highlighted row visible. A browse list is the whole master, so
   * arrowing down walks straight out of the scroll box without this, and
   * opening on the chosen item is pointless if it is three hundred rows up.
   */
  useEffect(() => {
    if (!showing) return;
    document
      .getElementById(`${listId}-opt-${active}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [showing, active, listId]);

  /** Open the whole list, highlighting whatever is already chosen. */
  const browse = () => {
    const all = searchItems(items, '', BROWSE_LIMIT);
    const chosen = all.findIndex((item) => fold(item?.name) === fold(query));
    setBrowsing(true);
    setActive(chosen >= 0 ? chosen : 0);
    setOpen(true);
  };

  /**
   * Where the portalled list goes. Measured from the input every time, and
   * re-measured on any scroll -- `capture` is what catches the row grid's own
   * scrolling, which does not bubble.
   */
  useLayoutEffect(() => {
    if (!cell || !open) return undefined;

    const measure = () => {
      const node = box.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      // Opens upwards only when there is genuinely more room up there, so a
      // box in the middle of the screen keeps the usual direction.
      const up = below < LIST_HEIGHT && r.top > below;
      setAt({
        left: Math.max(8, r.left),
        width: r.width,
        top: up ? undefined : r.bottom + 4,
        bottom: up ? window.innerHeight - r.top + 4 : undefined,
        maxHeight: Math.max(140, (up ? r.top : below) - 12),
      });
    };

    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [cell, open, matches.length, box]);

  const choose = (item) => {
    if (!item) return;
    onPick?.(item);
    // Uncontrolled only: cleared so the next item can be typed straight away
    // -- the point of the billing box is that a clerk adds ten lines without
    // reaching for the mouse once. Controlled, the caller owns the text and
    // the chosen name has to stay visible in the draft line or the cell.
    if (!controlled) setOwnQuery('');
    setOpen(false);
    setBrowsing(false);
    setActive(0);
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      // Closed, the first ArrowDown opens the list the way a `<select>` does
      // -- the whole of it, not a filter of what happens to be in the box.
      if (!open) {
        browse();
        return;
      }
      setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        browse();
        return;
      }
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      // ALWAYS prevented, whether or not anything is highlighted. Enter in
      // this box must never reach the form: it would post the invoice. A
      // caller that wants Enter for something of its own -- the grids move
      // down a column with it -- is handed it through `onEnter` instead of
      // being allowed to see the raw event.
      event.preventDefault();
      if (open && matches[active]) choose(matches[active]);
      else onEnter?.(event);
      return;
    }
    if (event.key === 'Escape') {
      // Only swallowed when there is a list to close, so Escape still
      // reaches the screen's own handler otherwise.
      if (open) {
        event.preventDefault();
        setOpen(false);
        setBrowsing(false);
      }
      return;
    }
    // Tab is left alone, deliberately: leaving the box by Tab is the
    // browser's job and overriding it is how focus order stops making sense.
  };

  const activeId = matches.length ? `${listId}-opt-${active}` : undefined;

  const list = (
    <ul
      id={`${listId}-list`}
      role="listbox"
      aria-label="Matching items"
      style={
        cell && at
          ? {
              position: 'fixed',
              left: at.left,
              top: at.top,
              bottom: at.bottom,
              width: at.width,
              maxHeight: at.maxHeight,
            }
          : undefined
      }
      className={
        cell
          ? 'z-50 overflow-y-auto rounded-lg border border-border bg-card shadow-lg'
          : 'absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-card shadow-lg'
      }
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
  );

  const nothing = (
    <div
      style={
        cell && at
          ? {
              position: 'fixed',
              left: at.left,
              top: at.top,
              bottom: at.bottom,
              width: at.width,
            }
          : undefined
      }
      className={
        cell
          ? 'z-50 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg'
          : 'absolute left-0 right-0 top-full z-40 mt-1 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg'
      }
    >
      Nothing matches &ldquo;{query}&rdquo;.{emptyHint ? ` ${emptyHint}` : ''}
    </div>
  );

  // A portal needs a document, which the first server render has not got.
  const canPortal = cell && typeof document !== 'undefined' && at;
  const float = (node) => (canPortal ? createPortal(node, document.body) : node);

  const hintText = hint === undefined ? (cell ? '' : FIELD_HINT) : hint;

  return (
    <div className={`${cell ? 'relative' : 'relative flex flex-col'} ${className}`}>
      {!cell && (
        <label className="field-label mb-1" htmlFor={`${listId}-input`}>
          {label}
        </label>
      )}

      <div className="relative">
        <input
          {...inputProps}
          id={`${listId}-input`}
          ref={box}
          type="text"
          className={`${
            inputClassName ?? (cell ? 'field-input field-input-sm w-full' : 'field-input')
          } pr-8`}
          value={query}
          role="combobox"
          aria-expanded={showing}
          aria-controls={`${listId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open ? activeId : undefined}
          aria-label={cell ? label : undefined}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            // Typing narrows: the list stops being the master and becomes
            // the shortlist for what has been typed.
            setBrowsing(false);
            setQuery(e.target.value);
            setOpen(true);
          }}
          // Clicking the box opens it, as a dropdown does. Focus alone does
          // too, so tabbing into it shows what is on offer.
          onFocus={browse}
          onClick={() => {
            if (!open) browse();
          }}
          // A click elsewhere closes the list, but not before the click has
          // landed -- hence the delay rather than an immediate close.
          onBlur={() =>
            setTimeout(() => {
              setOpen(false);
              setBrowsing(false);
            }, 120)
          }
          /* Alt+A here creates the item whose name is half typed --
             Sigfa's whole reason for the key. */
          data-master-field='item'
          onKeyDown={onKeyDown}
        />

        {/* The affordance the search-only box was missing: something to say
            there is a list behind this and you may just look at it. Out of
            the tab order, because the input it belongs to is already in it,
            and it does nothing the keyboard cannot already do. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          // Keeps the caret where it is: a mousedown that stole focus would
          // blur the input and the blur handler would close what this opens.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) {
              setOpen(false);
              setBrowsing(false);
            } else {
              box.current?.focus();
              browse();
            }
          }}
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {hintText && <p className="field-hint mt-1">{hintText}</p>}

      {showing && float(list)}

      {open && !browsing && query && matches.length === 0 && float(nothing)}
    </div>
  );
}
