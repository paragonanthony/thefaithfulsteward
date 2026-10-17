import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Modal } from './ui.jsx';
import { TXN_LABEL, acct, date, money, txnPath } from '../format.js';

const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '' : `${v.toFixed(1)}%`);
const cellText = (col, v) => (col.kind === 'percent' ? pct(v) : acct(v / 100));

/** Flatten a report result into rows of strings (for CSV export). */
export function reportToRows(name, result) {
  const header = ['', ...result.columns.flatMap((c) => (result.hasPercent && !c.derived ? [c.label, `${c.label} %`] : [c.label]))];
  const out = [[name], [result.organization], [result.subtitle], [], header];
  for (const l of result.lines) {
    if (l.type === 'spacer') { out.push([]); continue; }
    const label = `${'  '.repeat(l.level || 0)}${l.label || ''}`;
    if (!l.values) { out.push([label]); continue; }
    out.push([label, ...result.columns.flatMap((c, i) => {
      const v = l.values[i];
      const text = c.kind === 'percent' ? (v === null ? '' : v.toFixed(1)) : (v / 100).toFixed(2);
      return result.hasPercent && !c.derived ? [text, l.percents?.[i] == null ? '' : l.percents[i].toFixed(1)] : [text];
    })]);
  }
  return out;
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c ?? '')) ? `"${String(c).replace(/"/g, '""')}"` : c ?? '')).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Drilldown({ cell, fundFilter, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  React.useEffect(() => {
    api.post('/reports/drilldown', { accountIds: cell.line.accountIds, from: cell.line.drillFrom ?? cell.col.from, to: cell.col.to, funds: cell.col.funds, fundFilter })
      .then(setRows).catch(setError);
  }, [cell, fundFilter]);
  const dr = (rows || []).reduce((s, r) => s + Number(r.debit), 0);
  const cr = (rows || []).reduce((s, r) => s + Number(r.credit), 0);
  return (
    <Modal title={`${cell.line.label} — ${cell.col.label}`} onClose={onClose} width={980}>
      <div className="muted small mb">{(cell.line.drillFrom ?? cell.col.from) ? `${date(cell.line.drillFrom ?? cell.col.from)} – ${date(cell.col.to)}` : `Through ${date(cell.col.to)}`}</div>
      {error && <div className="alert alert-error">{error.message}</div>}
      {!rows && !error && <div className="muted">Loading…</div>}
      {rows && (
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Name</th><th>Account</th><th>Fund</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{date(r.date)}</td>
                  <td>{r.transaction_id ? <Link to={txnPath(r.transaction_type, r.transaction_id)}>{r.entry_kind === 'transaction' ? TXN_LABEL[r.transaction_type] : r.description}</Link> : r.description}</td>
                  <td>{r.check_number || r.ref_number}</td>
                  <td>{r.company_name}</td>
                  <td>{r.account_number ? `${r.account_number} · ` : ''}{r.account_name}</td>
                  <td>{r.fund_name}</td>
                  <td className="truncate">{r.memo}</td>
                  <td className="num">{Number(r.debit) ? acct(r.debit) : ''}</td>
                  <td className="num">{Number(r.credit) ? acct(r.credit) : ''}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="muted center">No entries.</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan={7}>Totals (net {money(dr - cr)})</td><td className="num">{acct(dr)}</td><td className="num">{acct(cr)}</td></tr></tfoot>
          </table>
        </div>
      )}
    </Modal>
  );
}

export default function ReportTable({ name, result, fundFilter }) {
  const [cell, setCell] = useState(null);
  if (!result) return null;
  const { columns, lines, hasPercent } = result;
  const cols = columns.flatMap((c, i) => (hasPercent && !c.derived ? [{ ...c, i }, { ...c, i, pctCol: true }] : [{ ...c, i }]));
  return (
    <div className="report">
      <div className="report-head">
        <div className="report-org">{result.organization}</div>
        <div className="report-name">{name}</div>
        <div className="report-sub">{result.subtitle}</div>
        {result.budget && <div className="report-sub">Budget: {result.budget.name}{result.budget.fund_name ? ` (${result.budget.fund_name} fund)` : ' (all funds)'}</div>}
        {result.fundFilter && <div className="report-sub">Funds: {result.fundFilter.join(', ')}</div>}
      </div>
      <div className="table-wrap report-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th />
              {cols.map((c, k) => <th key={k} className={`num${c.isTotal ? ' total-col' : ''}`}>{c.pctCol ? '%' : c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => {
              if (l.type === 'spacer') return <tr key={idx} className="r-spacer"><td colSpan={cols.length + 1} /></tr>;
              const cls = `r-${l.type}${l.style ? ` r-${l.style}` : ''}`;
              const canDrill = l.accountIds?.length > 0;
              return (
                <tr key={idx} className={cls}>
                  <td className="r-label" style={{ paddingLeft: `${0.75 + (l.level || 0) * 1.25}rem` }}>{l.link ? <Link to={l.link}>{l.label}</Link> : l.label}</td>
                  {l.values && cols.map((c, k) => {
                    const v = c.pctCol ? l.percents?.[c.i] : l.values[c.i];
                    const text = c.pctCol ? pct(v) : cellText(c, v);
                    const drill = canDrill && !c.derived && !c.pctCol && !c.budget && !c.noDrill;
                    return (
                      <td key={k} className={`num${c.isTotal ? ' total-col' : ''}${!c.pctCol && c.kind !== 'percent' && v < 0 ? ' neg' : ''}`}>
                        {drill ? <button type="button" className="cell-link" onClick={() => setCell({ line: l, col: c })}>{text}</button> : text}
                      </td>
                    );
                  })}
                  {!l.values && <td colSpan={cols.length} />}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {cell && <Drilldown cell={cell} fundFilter={fundFilter} onClose={() => setCell(null)} />}
    </div>
  );
}
