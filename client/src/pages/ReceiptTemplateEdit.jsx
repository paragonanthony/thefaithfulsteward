import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Page } from '../components/ui.jsx';
import ReceiptDoc, { sampleReceiptData } from '../components/ReceiptDoc.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

const PX_PER_IN = 96;

/** Read an image file, shrink it to at most maxPx wide, and return a data URL. */
async function imageToDataUrl(file, maxPx) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG, GIF or WebP image');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const ratio = Math.min(1, maxPx / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * ratio);
    canvas.height = Math.round(img.naturalHeight * ratio);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    // PNG or JPEG only: the formats PDF receipts can embed.
    const out = file.type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.88) : canvas.toDataURL('image/png');
    if (out.length > 680 * 1024) throw new Error('That image is too large even after resizing. Try a smaller image.');
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ImagePicker({ label, value, onChange, maxPx, onError }) {
  return (
    <Field label={label}>
      <div className="row gap wrap">
        {value && <img src={value} alt="" className="img-thumb" />}
        <label className="btn btn-sm">
          {value ? 'Replace…' : 'Upload…'}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
            onChange={async (e) => {
              const f = e.target.files[0];
              e.target.value = '';
              if (!f) return;
              try { onChange(await imageToDataUrl(f, maxPx)); } catch (err) { onError(err); }
            }} />
        </label>
        {value && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(null)}>Remove</button>}
      </div>
    </Field>
  );
}

export default function ReceiptTemplateEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { isOrgAdmin } = useApp();
  const [meta, setMeta] = useState(null);
  const [org, setOrg] = useState(null);
  const [rec, setRec] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const previewRef = useRef(null);
  const [scale, setScale] = useState(0.7);
  const focused = useRef(null); // last focused text area, for inserting merge fields

  useEffect(() => {
    Promise.all([api.get('/receipt-templates/meta'), api.get('/org'), isNew ? null : api.get(`/receipt-templates/${id}`)])
      .then(([m, o, r]) => {
        setMeta(m); setOrg(o);
        const start = r || { name: 'New receipt template', is_default: false, template: structuredClone(m.defaultTemplate) };
        setRec(start); setSaved(JSON.stringify(start));
      })
      .catch(setError);
  }, [id, isNew]);

  const ready = Boolean(rec && meta);
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) return undefined;
    const update = () => setScale(Math.min(1, el.clientWidth / (8.5 * PX_PER_IN)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  if (!ready) return <Page title="Receipt Template"><ErrorBanner error={error} /></Page>;
  const tpl = rec.template;
  const dirty = JSON.stringify(rec) !== saved;
  const set = (patch) => setRec({ ...rec, template: { ...tpl, ...patch } });
  const readOnly = !isOrgAdmin;

  const insertField = (key) => {
    const target = focused.current;
    if (!target) return;
    const token = `{{${key}}}`;
    const el = document.getElementById(`rt-${target}`);
    const value = tpl[target] || '';
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set({ [target]: value.slice(0, start) + token + value.slice(end) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  };
  const textArea = (key, label, rows = 3, hint) => (
    <Field label={label} hint={hint}>
      <textarea id={`rt-${key}`} className="input" rows={rows} value={tpl[key]} onFocus={() => { focused.current = key; }}
        onChange={(e) => set({ [key]: e.target.value })} />
    </Field>
  );

  const save = async () => {
    setError(null);
    try {
      const body = { name: rec.name, template: tpl };
      const r = isNew ? await api.post('/receipt-templates', body) : await api.put(`/receipt-templates/${id}`, body);
      if (isNew) { navigate(`/setup/receipts/${r.id}`, { replace: true }); return; }
      setRec(r); setSaved(JSON.stringify(r)); setMsg('Saved.');
    } catch (e) { setError(e); }
  };
  const makeDefault = async () => {
    try {
      await api.post(`/receipt-templates/${id}/default`);
      const next = { ...rec, is_default: true };
      setRec(next); setSaved(JSON.stringify(next)); setMsg('This is now the default receipt.');
    } catch (e) { setError(e); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the receipt template "${rec.name}"?`)) return;
    try { await api.del(`/receipt-templates/${id}`); navigate('/setup?tab=receipts'); } catch (e) { setError(e); }
  };

  const check = (key, label) => <label className="check"><input type="checkbox" checked={tpl[key]} onChange={(e) => set({ [key]: e.target.checked })} /> {label}</label>;

  return (
    <Page title="Receipt Template" subtitle={rec.is_default ? 'Default receipt' : undefined} wide
      actions={<>
        <Link className="btn" to="/setup?tab=receipts">Back</Link>
        {!isNew && !rec.is_default && isOrgAdmin && <button type="button" className="btn" onClick={makeDefault} disabled={dirty}>Make default</button>}
        {isOrgAdmin && <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty && !isNew}>Save</button>}
      </>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      {readOnly && <div className="alert alert-warn">Only organization administrators can change receipt templates.</div>}
      <div className="checkfmt">
        <fieldset className="checkfmt-left" disabled={readOnly}>
          <section className="card form">
            <Field label="Template name"><input className="input" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} /></Field>
            <Field label="Receipt title"><input className="input" value={tpl.title} onChange={(e) => set({ title: e.target.value })} /></Field>
            <div className="grid g3">
              <Field label="Accent color"><input type="color" className="input color-input" value={tpl.accentColor} onChange={(e) => set({ accentColor: e.target.value })} /></Field>
              <Field label="Font">
                <select className="input" value={tpl.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>{meta.fonts.map((f) => <option key={f}>{f}</option>)}</select>
              </Field>
              <Field label="Size (pt)"><input type="number" className="input num" min={8} max={16} step={0.5} value={tpl.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Date format">
              <select className="input" value={tpl.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>{meta.dateFormats.map((f) => <option key={f}>{f}</option>)}</select>
            </Field>
          </section>

          <section className="card form">
            <div className="subhead flush">Header</div>
            <ImagePicker label="Logo" value={tpl.logo} maxPx={1200} onChange={(v) => set({ logo: v })} onError={setError} />
            {tpl.logo && <Field label="Logo width (in)"><input type="number" className="input num" min={0.5} max={4} step={0.1} value={tpl.logoWidth} onChange={(e) => set({ logoWidth: Number(e.target.value) })} /></Field>}
            <div className="check-row">
              {check('showOrgAddress', 'Organization address')}
              {check('showOrgContact', 'Phone & email')}
              {check('showEin', 'EIN')}
              {check('showReceiptNumber', 'Receipt number')}
            </div>
            <p className="muted small flush">Organization name, address, phone, email and EIN come from <Link to="/settings">Organization settings</Link>.</p>
          </section>

          <section className="card form">
            <div className="subhead flush">Donor &amp; gift details</div>
            <div className="check-row">
              {check('showDonorAddress', 'Donor address')}
              {check('windowEnvelope', 'Position address for a #10 window envelope')}
              {check('showLines', 'Itemized lines')}
              {tpl.showLines && check('showFund', 'Fund column')}
              {tpl.showLines && check('showAccount', 'Account column')}
              {check('showPaymentMethod', 'Payment method')}
            </div>
          </section>

          <section className="card form">
            <div className="subhead flush">Wording</div>
            <div className="merge-help">
              <span className="muted small">Insert into the selected box:</span>
              <div className="chips">
                {Object.entries(meta.mergeFields).map(([k, label]) => (
                  <button key={k} type="button" className="chip" title={label} onMouseDown={(e) => e.preventDefault()} onClick={() => insertField(k)}>{`{{${k}}}`}</button>
                ))}
              </div>
            </div>
            {textArea('intro', 'Opening message', 4, 'Leave a blank line between paragraphs')}
            {textArea('closing', 'Closing message', 3)}
            {check('showTaxStatement', 'Tax acknowledgment statement')}
            {tpl.showTaxStatement && textArea('taxStatement', 'Tax acknowledgment', 3, 'Check the wording with your accountant; it should match your organization’s tax status')}
            {textArea('footer', 'Footer', 2)}
          </section>

          <section className="card form">
            <div className="subhead flush">Signature</div>
            {check('showSignature', 'Include a signature block')}
            {tpl.showSignature && (
              <>
                <ImagePicker label="Signature image (optional)" value={tpl.signatureImage} maxPx={900} onChange={(v) => set({ signatureImage: v })} onError={setError} />
                <div className="grid g2">
                  <Field label="Name"><input className="input" value={tpl.signatureName} onChange={(e) => set({ signatureName: e.target.value })} /></Field>
                  <Field label="Title"><input className="input" value={tpl.signatureTitle} onChange={(e) => set({ signatureTitle: e.target.value })} /></Field>
                </div>
              </>
            )}
          </section>
          {!isNew && !rec.is_default && isOrgAdmin && <button type="button" className="btn btn-danger" onClick={remove}>Delete template</button>}
          {!isNew && <AuditInfo table="receipt_templates" id={id} refreshKey={saved} />}
        </fieldset>

        <div className="checkfmt-right">
          <div className="card">
            <div className="subhead flush">Preview <span className="muted small">(sample data)</span></div>
            <div ref={previewRef} className="check-preview" style={{ height: `${11 * PX_PER_IN * scale}px` }}>
              <ReceiptDoc tpl={tpl} data={sampleReceiptData(org)} scale={scale} />
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
