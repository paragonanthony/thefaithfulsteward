import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useGoBack } from '../components/ui.jsx';
import { useApp } from '../App.jsx';
import { date, longDate, money } from '../format.js';
import CheckSheet, { sampleCheckData } from '../components/CheckSheet.jsx';
import ReceiptDoc, { orgInfo } from '../components/ReceiptDoc.jsx';
import { qs } from '../api.js';

const receiptPdfUrl = (incomeId, templateId, download = false) => `/api/receipts/${incomeId}/pdf${qs({ templateId, download: download ? 1 : null })}`;

const ENDPOINT = { income: '/income', expense: '/expenses', deposit: '/deposits' };
const BACK = { income: '/income', expense: '/expenses', deposit: '/deposits' };

const addressLines = (x) => [x.address1, x.address2, [x.city, x.state, x.postal].filter(Boolean).join(', ')].filter(Boolean);

/** Printable check using a saved check format (or an alignment test with sample data). */
function CheckPrint({ formats, formatId, setFormatId, data, onBack, test }) {
  const format = formats.find((f) => f.id === formatId) || formats[0];
  return (
    <div className="print-shell check-print-shell">
      <div className="print-toolbar no-print">
        <button type="button" className="btn" onClick={onBack}>← Back</button>
        {!test && formats.length > 1 && (
          <select className="input" style={{ width: 'auto' }} value={format.id} onChange={(e) => setFormatId(Number(e.target.value))} aria-label="Check format">
            {formats.map((f) => <option key={f.id} value={f.id}>{f.name}{f.is_default ? ' (default)' : ''}</option>)}
          </select>
        )}
        <Link className="btn" to={`/setup/check-formats/${format.id}`}>Customize format</Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <p className="print-tip no-print">
        {test ? 'Alignment test with sample data: print on plain paper and hold it against a blank check. ' : ''}
        In the print dialog, set <strong>Scale</strong> to 100% (Actual size) and <strong>Margins</strong> to None so positions match your check stock.
      </p>
      <div className="check-sheet-wrap"><CheckSheet layout={format.layout} data={data} /></div>
    </div>
  );
}

/** Printable income receipt using a receipt template. */
function ReceiptPrint({ incomeId, templates, templateId, setTemplateId, data, onBack }) {
  const tpl = templates.find((x) => x.id === templateId) || templates[0];
  return (
    <div className="print-shell check-print-shell">
      <div className="print-toolbar no-print">
        <button type="button" className="btn" onClick={onBack}>← Back</button>
        {templates.length > 1 && (
          <select className="input" style={{ width: 'auto' }} value={tpl.id} onChange={(e) => setTemplateId(Number(e.target.value))} aria-label="Receipt template">
            {templates.map((x) => <option key={x.id} value={x.id}>{x.name}{x.is_default ? ' (default)' : ''}</option>)}
          </select>
        )}
        <Link className="btn" to={`/setup/receipts/${tpl.id}`}>Customize receipt</Link>
        <a className="btn" href={receiptPdfUrl(incomeId, tpl.id, true)}>Download PDF</a>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="check-sheet-wrap"><ReceiptDoc tpl={tpl.template} data={data} /></div>
    </div>
  );
}

/** Printable donation receipt, check, or deposit slip. */
export default function PrintTxn() {
  const { kind, id } = useParams();
  const navigate = useNavigate();
  const { lookups } = useApp();
  const [t, setT] = useState(null);
  const [org, setOrg] = useState(null);
  const [company, setCompany] = useState(null);
  const [formats, setFormats] = useState(null);
  const [formatId, setFormatId] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [templateId, setTemplateId] = useState(null);
  const [error, setError] = useState(null);
  const goBack = useGoBack(`${BACK[kind] || ''}/${id}`); // back to the transaction (or wherever this was opened from)
  const isCheck = kind === 'expense' || kind === 'check-test';

  useEffect(() => {
    Promise.all([
      kind === 'check-test' ? null : api.get(`${ENDPOINT[kind]}/${id}`),
      api.get('/org'),
      isCheck ? api.get('/check-formats') : null,
      kind === 'income' ? api.get('/receipt-templates') : null,
    ])
      .then(async ([txn, o, f, rt]) => {
        setT(txn); setOrg(o); setFormats(f); setTemplates(rt);
        if (rt) setTemplateId(rt.find((x) => x.is_default)?.id || rt[0]?.id);
        if (txn?.company_id) setCompany(await api.get(`/companies/${txn.company_id}`));
      })
      .catch(setError);
  }, [kind, id, isCheck]);

  // Format: the one being tested, else the bank account's, else the organization default.
  useEffect(() => {
    if (!formats || formatId) return;
    if (kind === 'check-test') { setFormatId(Number(id)); return; }
    if (!t || !lookups) return;
    const acctFormat = lookups.accounts.find((a) => a.id === t.account_id)?.check_format_id;
    setFormatId(formats.some((f) => f.id === acctFormat) ? acctFormat : formats.find((f) => f.is_default)?.id || formats[0]?.id);
  }, [formats, t, lookups, kind, id, formatId]);

  if (error) return <div className="print-page"><p>{error.message}</p></div>;
  if (!org || (kind !== 'check-test' && !t) || (isCheck && !formatId)) return <div className="print-page">Loading…</div>;

  if (kind === 'check-test') {
    return <CheckPrint test formats={formats} formatId={formatId} setFormatId={setFormatId} data={sampleCheckData(org)} onBack={() => window.close()} />;
  }
  if (kind === 'income' && templates) {
    const data = {
      receiptNumber: String(t.id), date: t.date, amount: Number(t.amount), donorName: t.company_name || '',
      donorAddress: company ? addressLines(company) : [],
      paymentMethod: t.transaction_method === 'check' ? `check${t.check_number ? ` ${t.check_number}` : ''}` : 'electronic',
      checkNumber: t.check_number || '', memo: t.memo || '', fundName: t.fund_name || '',
      lines: t.lines.map((l) => ({ description: l.memo || t.memo || l.account_name, account: l.account_number ? `${l.account_number} · ${l.account_name}` : l.account_name, fund: l.fund_name || '', amount: Number(l.amount) })),
      org: orgInfo(org),
    };
    return <ReceiptPrint incomeId={Number(id)} templates={templates} templateId={templateId} setTemplateId={setTemplateId} data={data} onBack={goBack} />;
  }
  if (kind === 'expense') {
    const data = {
      date: t.date, checkNumber: t.check_number || '', payee: t.company_name || '', payeeAddress: company ? addressLines(company) : [],
      amount: Number(t.amount), memo: t.memo || '', bankName: t.account_name || '', orgName: org.name, orgAddress: addressLines(org),
      lines: t.lines.map((l) => ({ account: l.account_number ? `${l.account_number} · ${l.account_name}` : l.account_name, memo: l.memo || '', fund: l.fund_name || '', amount: Number(l.amount) })),
    };
    return <CheckPrint formats={formats} formatId={formatId} setFormatId={setFormatId} data={data} onBack={goBack} />;
  }

  const orgAddress = [org.address1, org.address2, [org.city, org.state, org.postal].filter(Boolean).join(', ')].filter(Boolean);
  const payeeAddress = company ? [company.address1, company.address2, [company.city, company.state, company.postal].filter(Boolean).join(', ')].filter(Boolean) : [];

  return (
    <div className="print-shell">
      <div className="print-toolbar no-print">
        <button type="button" className="btn" onClick={goBack}>← Back</button>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="print-page">
        {kind === 'deposit' && (
          <div className="receipt">
            <div className="print-org"><strong>{org.name}</strong></div>
            <h1>Deposit Summary</h1>
            <div className="print-meta"><div>Date: {longDate(t.date)}</div><div>Deposit to: {t.account_name}</div></div>
            <table className="print-table">
              <thead><tr><th>Date</th><th>Received From</th><th>Check #</th><th className="num">Amount</th></tr></thead>
              <tbody>{t.lines.map((l) => <tr key={l.id}><td>{date(l.linked_date)}</td><td>{l.linked_company_name}</td><td>{l.linked_check_number}</td><td className="num">{money(l.amount)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>Deposit total ({t.lines.length} items)</td><td className="num">{money(t.amount)}</td></tr></tfoot>
            </table>
            {t.memo && <p>{t.memo}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
