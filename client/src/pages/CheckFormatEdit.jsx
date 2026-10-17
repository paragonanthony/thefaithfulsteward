import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Page } from '../components/ui.jsx';
import CheckSheet, { PX_PER_IN, sampleCheckData } from '../components/CheckSheet.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

const POSITION_LABELS = { top: 'Check on top, 2 stubs below', middle: 'Check in the middle', bottom: 'Check on the bottom' };

function NumberIn({ value, onChange, step = 0.05, min, max, disabled, label }) {
  return (
    <input type="number" className="input num" aria-label={label} value={value} step={step} min={min} max={max} disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
  );
}

/** Scales the 8.5" sheet to fit its container. */
function useFitScale(ref, ready) {
  const [scale, setScale] = useState(0.8);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setScale(Math.min(1, el.clientWidth / (8.5 * PX_PER_IN)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, ready]);
  return scale;
}

export default function CheckFormatEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { isOrgAdmin } = useApp();
  const [meta, setMeta] = useState(null);
  const [org, setOrg] = useState(null);
  const [fmt, setFmt] = useState(null);
  const [saved, setSaved] = useState(null);
  const [selected, setSelected] = useState('payee');
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const previewRef = useRef(null);
  const scale = useFitScale(previewRef, Boolean(fmt && meta));

  useEffect(() => {
    Promise.all([api.get('/check-formats/meta'), api.get('/org'), isNew ? null : api.get(`/check-formats/${id}`)])
      .then(([m, o, f]) => {
        setMeta(m); setOrg(o);
        const start = f || { name: 'New check format', is_default: false, layout: structuredClone(m.defaultLayout) };
        setFmt(start); setSaved(JSON.stringify(start));
      })
      .catch(setError);
  }, [id, isNew]);

  if (!fmt || !meta) return <Page title="Check Format"><ErrorBanner error={error} /></Page>;
  const layout = fmt.layout;
  const dirty = JSON.stringify(fmt) !== saved;
  const setLayout = (patch) => setFmt({ ...fmt, layout: { ...layout, ...patch } });
  const setField = (key, patch) => setLayout({ fields: { ...layout.fields, [key]: { ...layout.fields[key], ...patch } } });

  const applyStock = (blank) => {
    const p = meta.blankStockPreset;
    const fields = { ...layout.fields };
    for (const [k, v] of Object.entries(p.fields)) fields[k] = { ...fields[k], show: blank ? v.show : false };
    setLayout({ printLabels: blank, printBorder: blank, fields });
  };

  const save = async () => {
    setError(null);
    try {
      const body = { name: fmt.name, layout };
      const r = isNew ? await api.post('/check-formats', body) : await api.put(`/check-formats/${id}`, body);
      if (isNew) { navigate(`/setup/check-formats/${r.id}`, { replace: true }); return; }
      setFmt(r); setSaved(JSON.stringify(r)); setMsg('Saved.');
    } catch (e) { setError(e); }
  };
  const makeDefault = async () => {
    try { await api.post(`/check-formats/${id}/default`); const f = { ...fmt, is_default: true }; setFmt(f); setSaved(JSON.stringify({ ...JSON.parse(saved), is_default: true })); setMsg('This is now the default check format.'); } catch (e) { setError(e); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the check format "${fmt.name}"?`)) return;
    try { await api.del(`/check-formats/${id}`); navigate('/setup?tab=checks'); } catch (e) { setError(e); }
  };

  const sel = layout.fields[selected];
  const readOnly = !isOrgAdmin;

  return (
    <Page title="Check Format" subtitle={fmt.is_default ? 'Default format' : undefined} wide
      actions={<>
        <Link className="btn" to="/setup?tab=checks">Back</Link>
        {!isNew && <button type="button" className="btn" title={dirty ? 'Save first to print your latest changes' : ''} disabled={dirty}
          onClick={() => window.open(`/print/check-test/${id}`, '_blank')}>Print alignment test</button>}
        {!isNew && !fmt.is_default && isOrgAdmin && <button type="button" className="btn" onClick={makeDefault} disabled={dirty}>Make default</button>}
        {isOrgAdmin && <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty && !isNew}>Save</button>}
      </>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      {readOnly && <div className="alert alert-warn">Only organization administrators can change check formats.</div>}
      <div className="checkfmt">
        <fieldset className="checkfmt-left" disabled={readOnly}>
          <section className="card form">
            <Field label="Format name"><input className="input" value={fmt.name} onChange={(e) => setFmt({ ...fmt, name: e.target.value })} /></Field>
            <div className="subhead flush">Check stock</div>
            <div className="row gap wrap">
              <button type="button" className="btn btn-sm" onClick={() => applyStock(false)} title="Your checks already show your name, bank details, check number and labels">Pre-printed checks</button>
              <button type="button" className="btn btn-sm" onClick={() => applyStock(true)} title="Print everything, including labels, border and your organization details">Blank check paper</button>
            </div>
            <div className="grid g2">
              <Field label="Check position">
                <select className="input" value={layout.checkPosition} onChange={(e) => setLayout({ checkPosition: e.target.value })}>
                  {meta.positions.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}
                </select>
              </Field>
              <Field label="Check height (in)"><NumberIn label="Check height" value={layout.checkHeight} min={2.5} max={4.5} onChange={(v) => setLayout({ checkHeight: v })} /></Field>
              <Field label="Voucher stubs">
                <select className="input" value={layout.stubs} onChange={(e) => setLayout({ stubs: Number(e.target.value) })}>
                  <option value={0}>None</option><option value={1}>1 stub</option><option value={2}>2 stubs</option>
                </select>
              </Field>
              <label className="check mt"><input type="checkbox" checked={layout.stubDetail} onChange={(e) => setLayout({ stubDetail: e.target.checked })} disabled={!layout.stubs} /> Show expense lines on stubs</label>
            </div>
          </section>

          <section className="card form">
            <div className="subhead flush">Text</div>
            <div className="grid g3">
              <Field label="Font">
                <select className="input" value={layout.fontFamily} onChange={(e) => setLayout({ fontFamily: e.target.value })}>
                  {meta.fonts.map((f) => <option key={f}>{f}</option>)}
                </select>
              </Field>
              <Field label="Size (pt)"><NumberIn label="Font size" value={layout.fontSize} step={0.5} min={7} max={16} onChange={(v) => setLayout({ fontSize: v })} /></Field>
              <Field label="Date format">
                <select className="input" value={layout.dateFormat} onChange={(e) => setLayout({ dateFormat: e.target.value })}>
                  {meta.dateFormats.map((f) => <option key={f}>{f}</option>)}
                </select>
              </Field>
            </div>
            <div className="check-row">
              <label className="check"><input type="checkbox" checked={layout.protectAmounts} onChange={(e) => setLayout({ protectAmounts: e.target.checked })} /> Fill amounts with *** (prevents alteration)</label>
              <label className="check"><input type="checkbox" checked={layout.printLabels} onChange={(e) => setLayout({ printLabels: e.target.checked })} /> Print labels (Pay to, Memo, Date)</label>
              <label className="check"><input type="checkbox" checked={layout.printBorder} onChange={(e) => setLayout({ printBorder: e.target.checked })} /> Print border</label>
            </div>
            {layout.fields.signature.show && <Field label="Signature line text"><input className="input" value={layout.signatureText} onChange={(e) => setLayout({ signatureText: e.target.value })} /></Field>}
          </section>

          <section className="card form">
            <div className="subhead flush">Printer alignment</div>
            <p className="muted small flush">Print an alignment test on plain paper, hold it against a blank check, and nudge everything until it lines up. Positive values move right / down.</p>
            <div className="grid g2">
              <Field label="Move right (in)"><NumberIn label="Horizontal offset" value={layout.offsetX} min={-1} max={1} onChange={(v) => setLayout({ offsetX: v })} /></Field>
              <Field label="Move down (in)"><NumberIn label="Vertical offset" value={layout.offsetY} min={-1} max={1} onChange={(v) => setLayout({ offsetY: v })} /></Field>
            </div>
          </section>

          <section className="card">
            <div className="row between"><div className="subhead flush">Fields</div>
              <button type="button" className="link small" onClick={() => setLayout({ fields: structuredClone(meta.defaultLayout.fields) })}>Reset positions</button></div>
            <p className="muted small">Drag fields on the preview, or type positions in inches from the check's top-left corner.</p>
            <table className="table compact fields-table">
              <thead><tr><th>Print</th><th>Field</th><th className="num">Left</th><th className="num">Top</th><th className="num">Width</th></tr></thead>
              <tbody>
                {Object.entries(meta.fields).map(([key, def]) => {
                  const f = layout.fields[key];
                  return (
                    <tr key={key} className={selected === key ? 'selected' : ''} onClick={() => setSelected(key)}>
                      <td className="center"><input type="checkbox" aria-label={`Print ${def.label}`} checked={f.show} onChange={(e) => setField(key, { show: e.target.checked })} /></td>
                      <td>{def.label}</td>
                      <td><NumberIn label={`${def.label} left`} value={f.x} onChange={(v) => setField(key, { x: v })} disabled={!f.show} /></td>
                      <td><NumberIn label={`${def.label} top`} value={f.y} onChange={(v) => setField(key, { y: v })} disabled={!f.show} /></td>
                      <td><NumberIn label={`${def.label} width`} value={f.w} onChange={(v) => setField(key, { w: v })} disabled={!f.show} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          {!isNew && !fmt.is_default && isOrgAdmin && <button type="button" className="btn btn-danger" onClick={remove}>Delete format</button>}
          {!isNew && <AuditInfo table="check_formats" id={id} refreshKey={saved} />}
        </fieldset>

        <div className="checkfmt-right">
          <div className="card">
            <div className="row between wrap gap">
              <div className="subhead flush">Preview <span className="muted small">(sample data · {sel?.show ? `${meta.fields[selected].label} selected` : 'click a field to select it'})</span></div>
            </div>
            <div ref={previewRef} className="check-preview" style={{ height: `${11 * PX_PER_IN * scale}px` }}>
              <CheckSheet layout={layout} data={sampleCheckData(org)} scale={scale} editable={!readOnly}
                selected={selected} onSelect={setSelected} onMove={(key, pos) => setField(key, pos)} />
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
