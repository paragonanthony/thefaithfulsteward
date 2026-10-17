import React, { useRef } from 'react';
import { amountInWords } from '../format.js';

export const PX_PER_IN = 96; // CSS inch
const SHEET_W = 8.5;
const SHEET_H = 11;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatCheckDate(iso, fmt) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  switch (fmt) {
    case 'MM/DD/YY': return `${m}/${d}/${y.slice(2)}`;
    case 'Month D, YYYY': return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
    case 'DD/MM/YYYY': return `${d}/${m}/${y}`;
    case 'YYYY-MM-DD': return `${y}-${m}-${d}`;
    default: return `${m}/${d}/${y}`;
  }
}

/** Example data for previews and alignment test prints. */
export function sampleCheckData(org) {
  return {
    date: new Date().toISOString().slice(0, 10),
    checkNumber: '1042',
    payee: 'Sample Vendor Supply Co.',
    payeeAddress: ['1234 Main Street', 'Suite 200', 'Springfield, IL 62701'],
    amount: 1234.56,
    memo: 'Invoice 1001',
    bankName: 'Operating Checking',
    orgName: org?.name || 'Your Organization',
    orgAddress: org ? [org.address1, org.address2, [org.city, org.state, org.postal].filter(Boolean).join(', ')].filter(Boolean) : ['123 Example Ave', 'Springfield, IL 62701'],
    lines: [
      { account: '5100 · Program Supplies', memo: 'Classroom materials', fund: 'Youth Program', amount: 834.56 },
      { account: '5300 · Office Supplies', memo: 'Paper and toner', fund: 'General Fund', amount: 400 },
    ],
  };
}

/** Where the check and stubs sit on the sheet, in inches from the top. */
function sections(layout) {
  const stubH = (SHEET_H - layout.checkHeight) / 2;
  const slots = { top: [0, layout.checkHeight, layout.checkHeight + stubH], middle: [stubH, 0, stubH + layout.checkHeight], bottom: [2 * stubH, 0, stubH] }[layout.checkPosition];
  return { checkTop: slots[0], stubTops: slots.slice(1, 1 + layout.stubs), stubH };
}

function fieldContent(key, layout, data) {
  const labels = layout.printLabels;
  const small = { fontSize: '0.7em', marginRight: '0.6em', fontFamily: 'Arial, sans-serif' };
  switch (key) {
    case 'date': return <>{labels && <span style={small}>DATE</span>}{formatCheckDate(data.date, layout.dateFormat)}</>;
    case 'payee': return <>{labels && <span style={small}>PAY TO THE ORDER OF</span>}{data.payee}</>;
    case 'amount': return <>{labels && '$ '}{layout.protectAmounts ? '**' : ''}{num.format(data.amount)}</>;
    case 'amountWords': return (
      <span style={{ display: 'flex', overflow: 'hidden' }}>
        <span style={{ whiteSpace: 'nowrap' }}>{amountInWords(data.amount)}</span>
        {layout.protectAmounts && <span style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', marginLeft: '0.4em' }}>{'*'.repeat(120)}</span>}
        {labels && <span style={{ ...small, marginLeft: '0.6em', marginRight: 0 }}>DOLLARS</span>}
      </span>
    );
    case 'address': return <div style={{ whiteSpace: 'normal', lineHeight: 1.25 }}><div>{data.payee}</div>{data.payeeAddress.map((l, i) => <div key={i}>{l}</div>)}</div>;
    case 'memo': return <>{labels && <span style={small}>MEMO</span>}{data.memo}</>;
    case 'orgInfo': return <div style={{ whiteSpace: 'normal', lineHeight: 1.25 }}><strong>{data.orgName}</strong>{data.orgAddress.map((l, i) => <div key={i}>{l}</div>)}</div>;
    case 'bankName': return data.bankName;
    case 'checkNumber': return <strong>{data.checkNumber}</strong>;
    case 'signature': return <div style={{ borderTop: '1px solid #000', paddingTop: '0.05in', fontSize: '0.7em', fontFamily: 'Arial, sans-serif', textAlign: 'center', marginTop: '0.35in' }}>{layout.signatureText}</div>;
    default: return null;
  }
}

function Stub({ top, height, layout, data }) {
  const total = data.lines.reduce((s, l) => s + Number(l.amount), 0);
  return (
    <div className="check-stub-area" style={{ top: `${top + layout.offsetY}in`, left: `${layout.offsetX}in`, height: `${height}in` }}>
      <div className="stub-head">
        <strong>{data.payee}</strong>
        <span>{formatCheckDate(data.date, layout.dateFormat)}</span>
        {data.checkNumber && <span>Check {data.checkNumber}</span>}
        <strong>{num.format(data.amount)}</strong>
      </div>
      <div className="stub-sub">{data.bankName}{data.memo ? ` · ${data.memo}` : ''}</div>
      {layout.stubDetail && (
        <table className="stub-lines">
          <tbody>
            {data.lines.map((l, i) => <tr key={i}><td>{l.account}</td><td>{l.memo}</td><td>{l.fund}</td><td className="num">{num.format(l.amount)}</td></tr>)}
          </tbody>
          {data.lines.length > 1 && <tfoot><tr><td colSpan={3} /><td className="num">{num.format(total)}</td></tr></tfoot>}
        </table>
      )}
    </div>
  );
}

/**
 * A full letter-size check sheet drawn in real inches, so it prints to scale.
 * In the editor, pass `editable` with onSelect/onMove to drag fields.
 */
export default function CheckSheet({ layout, data, editable = false, selected, onSelect, onMove, scale = 1 }) {
  const drag = useRef(null);
  const { checkTop, stubTops, stubH } = sections(layout);
  const snap = (v) => Math.round(v * 20) / 20; // 0.05"

  const onPointerDown = (key) => (e) => {
    if (!editable) return;
    e.preventDefault();
    onSelect?.(key);
    const f = layout.fields[key];
    drag.current = { key, sx: e.clientX, sy: e.clientY, x: f.x, y: f.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / (PX_PER_IN * scale);
    const dy = (e.clientY - d.sy) / (PX_PER_IN * scale);
    const w = layout.fields[d.key].w;
    onMove?.(d.key, {
      x: Math.min(SHEET_W - Math.min(w, 0.5), Math.max(0, snap(d.x + dx))),
      y: Math.min(layout.checkHeight - 0.15, Math.max(0, snap(d.y + dy))),
    });
  };
  const onPointerUp = () => { drag.current = null; };

  return (
    <div className={`check-sheet${editable ? ' editing' : ''}`}
      style={{ fontFamily: `"${layout.fontFamily}", monospace`, fontSize: `${layout.fontSize}pt`, ...(scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'top left' } : {}) }}>
      <div className={`check-area${layout.printBorder ? ' bordered' : ''}`}
        style={{ top: `${checkTop + layout.offsetY}in`, left: `${layout.offsetX}in`, height: `${layout.checkHeight}in` }}>
        {Object.entries(layout.fields).filter(([, f]) => f.show).map(([key, f]) => (
          <div key={key}
            className={`check-field${editable ? ' movable' : ''}${selected === key ? ' selected' : ''}`}
            style={{ left: `${f.x}in`, top: `${f.y}in`, width: `${f.w}in` }}
            onPointerDown={onPointerDown(key)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            {fieldContent(key, layout, data)}
          </div>
        ))}
      </div>
      {stubTops.map((top, i) => <Stub key={i} top={top} height={stubH} layout={layout} data={data} />)}
    </div>
  );
}
