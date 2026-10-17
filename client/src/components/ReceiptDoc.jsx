import React from 'react';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatReceiptDate(iso, fmt) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  switch (fmt) {
    case 'MM/DD/YYYY': return `${m}/${d}/${y}`;
    case 'DD/MM/YYYY': return `${d}/${m}/${y}`;
    case 'YYYY-MM-DD': return `${y}-${m}-${d}`;
    default: return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
  }
}

/** Example data for the template editor preview. */
export function sampleReceiptData(org) {
  return {
    receiptNumber: '1042',
    date: new Date().toISOString().slice(0, 10),
    amount: 250,
    donorName: 'Jane Smith',
    donorAddress: ['482 Maple Avenue', 'Springfield, IL 62704'],
    paymentMethod: 'check 3318',
    checkNumber: '3318',
    memo: 'Annual appeal',
    fundName: 'General Fund',
    lines: [
      { description: 'Annual appeal gift', account: '4000 · Individual Contributions', fund: 'General Fund', amount: 200 },
      { description: 'Youth program sponsorship', account: '4000 · Individual Contributions', fund: 'Youth Program', amount: 50 },
    ],
    org: orgInfo(org),
  };
}

export function orgInfo(org) {
  return {
    name: org?.name || 'Your Organization',
    address: org ? [org.address1, org.address2, [org.city, org.state, org.postal].filter(Boolean).join(', ')].filter(Boolean) : [],
    phone: org?.phone || '',
    email: org?.email || '',
    ein: org?.ein || '',
  };
}

/** Replace {{merge_fields}} and render paragraphs (blank line) and line breaks as plain text. */
function Merged({ text, values, className }) {
  if (!text?.trim()) return null;
  const merged = text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) => (key in values ? values[key] : m));
  return merged.split(/\n\s*\n/).map((para, i) => (
    <p key={i} className={className}>
      {para.split('\n').map((line, j) => <React.Fragment key={j}>{j > 0 && <br />}{line}</React.Fragment>)}
    </p>
  ));
}

/** A letter-size receipt drawn in real inches so it prints to scale. */
export default function ReceiptDoc({ tpl, data, scale = 1 }) {
  const date = formatReceiptDate(data.date, tpl.dateFormat);
  const values = {
    donor_name: data.donorName || 'Friend', amount: usd.format(data.amount), date, receipt_number: data.receiptNumber,
    payment_method: data.paymentMethod, check_number: data.checkNumber || '', memo: data.memo || '', fund: data.fundName || '',
    org_name: data.org.name, ein: data.org.ein,
  };
  const contact = [data.org.phone, data.org.email].filter(Boolean).join(' · ');
  const donorBlock = (
    <div className={`rcpt-donor${tpl.windowEnvelope ? ' window' : ''}`}>
      {!tpl.windowEnvelope && <div className="rcpt-label">Received from</div>}
      <strong>{data.donorName || '—'}</strong>
      {tpl.showDonorAddress && data.donorAddress.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );

  return (
    <div className="receipt-sheet"
      style={{ '--accent': tpl.accentColor, fontFamily: `"${tpl.fontFamily}", serif`, fontSize: `${tpl.fontSize}pt`, ...(scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'top left' } : {}) }}>
      <header className={`rcpt-head${tpl.windowEnvelope ? ' window' : ''}`}>
        <div className="rcpt-brand">
          {tpl.logo && <img src={tpl.logo} alt="" style={{ width: `${tpl.logoWidth}in` }} />}
          <div className="rcpt-org">
            <strong>{data.org.name}</strong>
            {tpl.showOrgAddress && data.org.address.map((l, i) => <div key={i}>{l}</div>)}
            {tpl.showOrgContact && contact && <div>{contact}</div>}
            {tpl.showEin && data.org.ein && <div>EIN {data.org.ein}</div>}
          </div>
        </div>
        <div className="rcpt-titleblock">
          <h1>{tpl.title}</h1>
          <div>{date}</div>
          {tpl.showReceiptNumber && <div>Receipt #{data.receiptNumber}</div>}
        </div>
        {tpl.windowEnvelope && donorBlock}
      </header>

      {!tpl.windowEnvelope && donorBlock}
      <Merged text={tpl.intro} values={values} />

      {tpl.showLines ? (
        <table className="rcpt-lines">
          <thead><tr><th>Description</th>{tpl.showAccount && <th>Account</th>}{tpl.showFund && <th>Fund</th>}<th className="num">Amount</th></tr></thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i}><td>{l.description}</td>{tpl.showAccount && <td>{l.account}</td>}{tpl.showFund && <td>{l.fund}</td>}<td className="num">{usd.format(l.amount)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={1 + (tpl.showAccount ? 1 : 0) + (tpl.showFund ? 1 : 0)}>Total received</td><td className="num">{usd.format(data.amount)}</td></tr></tfoot>
        </table>
      ) : (
        <div className="rcpt-total"><span>Total received</span><strong>{usd.format(data.amount)}</strong></div>
      )}
      {tpl.showPaymentMethod && <div className="rcpt-method">Payment: {data.paymentMethod}</div>}

      <Merged text={tpl.closing} values={values} />
      {tpl.showTaxStatement && <div className="rcpt-tax"><Merged text={tpl.taxStatement} values={values} /></div>}

      {tpl.showSignature && (
        <div className="rcpt-signature">
          {tpl.signatureImage ? <img src={tpl.signatureImage} alt="" /> : <div className="rcpt-sigspace" />}
          <div className="rcpt-sigline" />
          {tpl.signatureName && <div>{tpl.signatureName}</div>}
          {tpl.signatureTitle && <div className="rcpt-muted">{tpl.signatureTitle}</div>}
        </div>
      )}

      {tpl.footer?.trim() && <footer className="rcpt-footer"><Merged text={tpl.footer} values={values} /></footer>}
    </div>
  );
}
