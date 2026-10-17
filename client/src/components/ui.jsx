import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';
import { useApp } from '../App.jsx';
import { iconFor } from '../icons.js';
import { api, qs } from '../api.js';

/**
 * A page with a title (and the area's icon, from the address). `panel` joins the header to the card right below it,
 * as on the transaction screens.
 */
export function Page({ title, subtitle, actions, children, wide, panel, icon }) {
  useEffect(() => { document.title = `${title} · The Faithful Steward`; }, [title]);
  const { pathname } = useLocation();
  const Icon = icon === null ? null : icon || iconFor(pathname);
  return (
    <div className={`page${wide ? ' page-wide' : ''}${panel ? ' page-panel' : ''}`}>
      <div className="page-head">
        <div className="page-title">
          {Icon && <span className="page-icon" aria-hidden="true"><Icon size={22} strokeWidth={2.1} /></span>}
          <div>
            <h1>{title}</h1>
            {subtitle && <div className="muted">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function ErrorBanner({ error, onClose }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      <span>{typeof error === 'string' ? error : error.message}</span>
      {onClose && <button type="button" className="link" onClick={onClose} aria-label="Dismiss">✕</button>}
    </div>
  );
}

export function Field({ label, children, hint, className = '', required }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}{required && <span className="req"> *</span>}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, width = 640 }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value}
          className={`tab${value === t.value ? ' active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

const CREATE = '__create__';

/**
 * Searchable dropdown. options: [{ value, label, hint }]
 * onCreate(typedText): when given, the list ends with an "+ Add …" entry (createLabel names the kind of record).
 */
export function Combo({ options, value, onChange, placeholder = 'Select', disabled, allowClear = true, id, autoFocus, onCreate, createLabel = 'new' }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef(null);
  const listRef = useRef(null);
  const selected = options.find((o) => String(o.value) === String(value ?? ''));
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    const list = q ? options.filter((o) => `${o.label} ${o.hint || ''}`.toLowerCase().includes(q)) : options;
    if (!onCreate) return list;
    const typed = text.trim();
    return [...list, { value: CREATE, label: typed ? `+ Add "${typed}" as a new ${createLabel}` : `+ Add new ${createLabel}…`, create: true }];
  }, [options, text, onCreate, createLabel]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView?.({ block: 'nearest' });
  }, [hi]);

  const choose = (o) => {
    if (o?.create) { onCreate(text.trim()); setOpen(false); setText(''); return; }
    onChange(o ? o.value : null); setOpen(false); setText('');
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); if (filtered[hi]) choose(filtered[hi]); }
    else if (e.key === 'Escape') { setOpen(false); setText(''); }
    else if (e.key === 'Tab') { if (open && text && filtered[hi] && !filtered[hi].create) choose(filtered[hi]); setOpen(false); }
  };

  return (
    <div className={`combo${disabled ? ' disabled' : ''}`} ref={ref}>
      <input
        id={id}
        autoFocus={autoFocus}
        className="input combo-input"
        disabled={disabled}
        placeholder={selected ? selected.label : placeholder}
        value={open ? text : selected ? selected.label : ''}
        onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => { setOpen(true); setHi(Math.max(0, filtered.indexOf(selected))); }}
        onKeyDown={onKey}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
      />
      {allowClear && selected && !disabled
        ? <button type="button" className="combo-clear" tabIndex={-1} onClick={() => choose(null)} aria-label="Clear"><X size={15} /></button>
        : <ChevronDown size={16} className="combo-caret" aria-hidden="true" />}
      {open && !disabled && (
        <ul className="combo-list" ref={listRef} role="listbox">
          {filtered.filter((o) => !o.create).length === 0 && <li className="combo-empty">No matches</li>}
          {filtered.map((o, i) => (
            <li key={o.value} role="option" aria-selected={i === hi}
              className={`${i === hi ? 'hi' : ''}${String(o.value) === String(value) ? ' sel' : ''}${o.create ? ' combo-create' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); choose(o); }} onMouseEnter={() => setHi(i)}>
              <span>{o.label}</span>{o.hint && <span className="combo-hint">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Account choices for a Combo. `key` re-runs the filter when something it depends on changes. */
export function useAccountOptions(filterFn = () => true, { includeInactive = false, current, key } = {}) {
  const { lookups } = useApp();
  return useMemo(() => {
    if (!lookups) return [];
    const typeLabels = Object.fromEntries(lookups.accountTypes.map((t) => [t.key, t.label]));
    return lookups.accounts
      .filter((a) => filterFn(a) && (includeInactive || a.is_active || String(a.id) === String(current)))
      .map((a) => ({ value: a.id, label: a.account_number ? `${a.account_number} · ${a.name}` : a.name, hint: typeLabels[a.account_type] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookups, current, key]);
}

export function useFundOptions(current) {
  const { lookups } = useApp();
  return useMemo(() => (lookups?.funds || [])
    .filter((f) => f.is_active || String(f.id) === String(current))
    .map((f) => ({ value: f.id, label: f.name })), [lookups, current]);
}

export function useCompanyOptions(current) {
  const { lookups } = useApp();
  return useMemo(() => (lookups?.companies || [])
    .filter((c) => c.is_active || String(c.id) === String(current))
    .map((c) => ({ value: c.id, label: c.name })), [lookups, current]);
}

/**
 * Leave a screen the way you came: back to the screen it was opened from (the previous page in the app), or to
 * `fallback` when it was opened directly (a link, bookmark or new tab).
 */
export function useGoBack(fallback) {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = window.history.state?.idx; // React Router's position in this tab's history
    if (typeof idx === 'number' && idx > 0) navigate(-1); else navigate(fallback);
  }, [navigate, fallback]);
}

export const isBanking = (a) => a.account_type === 'bank' || a.account_type === 'credit_card';

/**
 * Load a list one page (500 rows) at a time. `data` is the current page's rows; `total` and `totals` cover every
 * matching row. Changing the filters (params) goes back to page 1.
 */
export function usePagedLoad(path, params = {}) {
  const [sort, onSort] = useSort(`sort:${path}`);
  const key = `${path}${qs({ ...params, sort: sort?.key, dir: sort?.dir })}`;
  const [pg, setPg] = useState({ key, page: 1 });
  const page = pg.key === key ? pg.page : 1;
  const res = useLoad(() => api.get(`${path}${qs({ ...params, sort: sort?.key, dir: sort?.dir, page })}`), [key, page]);
  const d = res.data;
  return {
    ...res, data: d ? d.rows : null, total: d?.total ?? 0, totals: d?.totals || {}, page, pageSize: d?.pageSize ?? 500,
    setPage: (p) => setPg({ key, page: p }), sort, onSort,
  };
}

/**
 * Column sorting: { key, dir } or null for the list's usual order. onSort(key, firstDir) sorts by a column, or
 * reverses it when it's already the sort. Remembered for the session under storageKey.
 */
export function useSort(storageKey, initial = null) {
  const [sort, setSort] = useState(() => {
    try { const v = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); return v?.key ? v : initial; } catch { return initial; }
  });
  const onSort = (k, first = 'asc') => {
    const next = sort?.key === k ? { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: first };
    setSort(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
  };
  return [sort, onSort];
}

/** Sort rows in the browser (lists loaded whole). cols: { key: (row) => value }. */
export function sortRows(rows, sort, cols) {
  const get = sort && cols[sort.key];
  if (!rows || !get) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === y) return 0;
    if (x === null || x === undefined || x === '') return 1;
    if (y === null || y === undefined || y === '') return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })) * dir;
  });
}

/**
 * A column heading that sorts the list: click to sort, click again to reverse. `first` is the first direction
 * (dates and amounts start with the largest / newest first).
 */
export function SortTh({ k, sort, onSort, first = 'asc', className = '', style, children }) {
  const on = sort?.key === k;
  return (
    <th className={`sortable${on ? ' sorted' : ''}${className ? ` ${className}` : ''}`} style={style} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => onSort(k, first)} title="Sort by this column">
        {children}<span className="sort-ind" aria-hidden="true">{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

/** "Showing 501–1,000 of 2,663" with First / Previous / Next / Last; hidden when everything fits on one page. */
export function Pager({ page, pageSize, total, onPage, scroll = true }) {
  if (!total || total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const go = (p) => { onPage(p); if (scroll) window.scrollTo(0, 0); };
  const n = (x) => x.toLocaleString();
  return (
    <div className="pager">
      <span className="muted small">Showing {n((page - 1) * pageSize + 1)}–{n(Math.min(total, page * pageSize))} of {n(total)}</span>
      <div className="pager-btns">
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => go(1)}>First</button>
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => go(page - 1)}>‹ Previous</button>
        <span className="small">Page {page} of {pages}</span>
        <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => go(page + 1)}>Next ›</button>
        <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => go(pages)}>Last</button>
      </div>
    </div>
  );
}

/** Load data from the API with loading / error state. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ data: await fn(), loading: false, error: null });
    } catch (error) {
      setState({ data: null, loading: false, error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) };
}

export function DateRange({ from, to, onChange, children }) {
  return (
    <div className="filter-bar">
      <Field label="From"><input type="date" className="input" value={from} onChange={(e) => onChange({ from: e.target.value, to })} /></Field>
      <Field label="To"><input type="date" className="input" value={to} onChange={(e) => onChange({ from, to: e.target.value })} /></Field>
      {children}
    </div>
  );
}

/** Amount input. `currency` shows a "$" in front, for the main amount of a form. */
export function MoneyInput({ value, onChange, onBlur, currency, ...rest }) {
  const input = (
    <input type="text" inputMode="decimal" className="input num" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => {
        const n = Number(String(e.target.value).replace(/[$,\s]/g, ''));
        if (e.target.value !== '' && Number.isFinite(n)) onChange(n.toFixed(2));
        onBlur?.(e);
      }} {...rest} />
  );
  if (!currency) return input;
  return <div className={`input-group${rest.disabled ? ' disabled' : ''}`}><span className="input-addon" aria-hidden="true">$</span>{input}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}
