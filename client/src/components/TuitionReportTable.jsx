import React from 'react';
import { useNavigate } from 'react-router-dom';
import { date, money } from '../format.js';

const fmt = (col, v) => {
  if (v === null || v === undefined || v === '') return '';
  if (col.type === 'money') return money(v);
  if (col.type === 'date') return date(v);
  if (col.type === 'percent') return `${Number(v).toFixed(1)}%`;
  return String(v);
};
const csvVal = (col, v) => (v === null || v === undefined ? '' : col.type === 'money' ? Number(v).toFixed(2) : String(v));
const isNum = (col) => ['money', 'number', 'percent'].includes(col.type);

/** Rows of strings for CSV export. */
export function tuitionReportToRows(name, r) {
  const out = [[name], [r.organization], [r.subtitle], [], r.columns.map((c) => c.label)];
  const totalsRow = (label, totals) => r.columns.map((c, i) => (i === 0 ? label : c.key in totals ? csvVal(c, totals[c.key]) : ''));
  for (const g of r.groups) {
    if (g.label !== null && r.showDetail) out.push([g.label]);
    if (r.showDetail) for (const row of g.rows) out.push(r.columns.map((c) => csvVal(c, row[c.key])));
    if (g.label !== null && (r.showSubtotals || !r.showDetail)) out.push(totalsRow(r.showDetail ? `Total ${g.label}` : g.label, g.subtotal));
  }
  if (r.showTotals) out.push(totalsRow(`Total (${r.count} records)`, r.totals));
  return out;
}

export default function TuitionReportTable({ name, result }) {
  const navigate = useNavigate();
  if (!result) return null;
  const { columns } = result;
  const grouped = result.groupBy !== 'none';
  const totalsCells = (label, totals, cls) => (
    <tr className={cls}>
      {columns.map((c, i) => (
        <td key={c.key} className={isNum(c) ? 'num' : ''}>{i === 0 ? label : c.key in totals ? fmt(c, totals[c.key]) : ''}</td>
      ))}
    </tr>
  );
  return (
    <div className="report">
      <div className="report-head">
        <div className="report-org">{result.organization}</div>
        <div className="report-name">{name}</div>
        <div className="report-sub">{result.subtitle}</div>
      </div>
      <div className="table-wrap report-wrap">
        <table className="report-table tuition-report">
          <thead><tr>{columns.map((c) => <th key={c.key} className={isNum(c) ? 'num' : ''} style={{ textAlign: isNum(c) ? 'right' : 'left' }}>{c.label}</th>)}</tr></thead>
          <tbody>
            {result.groups.map((g, gi) => (
              <React.Fragment key={gi}>
                {grouped && result.showDetail && <tr className="r-header"><td colSpan={columns.length}>{g.label} <span className="muted small">({g.count})</span></td></tr>}
                {result.showDetail && g.rows.map((row) => (
                  <tr key={row.id} className="r-account clickable-row" onClick={() => navigate(`/tuition/${row.id}`)} title="Open tuition record">
                    {columns.map((c) => <td key={c.key} className={isNum(c) ? 'num' : ''} style={!isNum(c) ? { paddingLeft: grouped ? '1.5rem' : undefined } : undefined}>{fmt(c, row[c.key])}</td>)}
                  </tr>
                ))}
                {grouped && (result.showSubtotals || !result.showDetail) && totalsCells(result.showDetail ? `Total ${g.label}` : g.label, g.subtotal, result.showDetail ? 'r-subtotal' : 'r-account')}
              </React.Fragment>
            ))}
            {!result.count && <tr><td colSpan={columns.length} className="muted center">No tuition records match.</td></tr>}
          </tbody>
          {result.showTotals && result.count > 0 && <tfoot>{totalsCells(`Total · ${result.count} record${result.count === 1 ? '' : 's'}`, result.totals, 'r-formula r-grand')}</tfoot>}
        </table>
      </div>
    </div>
  );
}
