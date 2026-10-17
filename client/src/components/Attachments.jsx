import { Link } from 'react-router-dom';
import React, { useEffect, useRef, useState } from 'react';
import { CloudUpload, Download, FileText, Paperclip, Plus, Sparkles, X } from 'lucide-react';
import { api, qs } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner } from './ui.jsx';
import { date } from '../format.js';

let configCache = null;
function useAttachmentConfig() {
  const [config, setConfig] = useState(configCache);
  useEffect(() => {
    if (!configCache) api.get('/attachments/config').then((c) => { configCache = c; setConfig(c); }).catch(() => {});
  }, []);
  return config;
}

const readBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
  reader.readAsDataURL(file);
});

const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isImage = (a) => /^image\/(jpeg|png|gif|webp)$/.test(a.content_type);
const fileUrl = (a, download) => `/api/attachments/${a.id}/file${download ? '?download=1' : ''}`;

/** Attach files saved before a new record existed to the record once it has been saved. */
export async function linkPendingAttachments(pending, owner) {
  if (pending?.length) await api.post('/attachments/link', { ids: pending.map((p) => p.id), ...owner });
}

/**
 * Files attached to a transaction or tuition record, with "Fill from document" (Claude extraction).
 * owner: { transactionId } | { tuitionId } for a saved record, or null for a new one. New records keep their uploads in
 * `pending` (owned by the page) and link them with linkPendingAttachments after saving.
 * onExtracted(result) applies the extracted fields to the page's form.
 */
export default function Attachments({ owner, txnType, pending, onPendingChange, onExtracted, extractDisabled, refreshKey }) {
  const config = useAttachmentConfig();
  const { isOrgAdmin } = useApp();
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [extracting, setExtracting] = useState(null);
  const [result, setResult] = useState(null);
  const [drag, setDrag] = useState(false);
  const input = useRef(null);
  const ownerKey = owner ? JSON.stringify(owner) : null;

  useEffect(() => {
    setResult(null);
    if (!owner) { setSaved(null); return; }
    api.get(`/attachments${qs(owner)}`).then(setSaved).catch(setError);
  }, [ownerKey, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = owner ? saved || [] : pending || [];

  const upload = async (list) => {
    setError(null);
    const chosen = [...list];
    if (!chosen.length) return;
    const tooBig = chosen.filter((f) => config && f.size > config.maxBytes);
    if (tooBig.length) { setError(`${tooBig.map((f) => f.name).join(', ')}: files can be at most ${size(config.maxBytes)}.`); return; }
    setUploading((n) => n + chosen.length);
    const added = [];
    for (const f of chosen) {
      try {
        added.push(await api.post('/attachments', { fileName: f.name, data: await readBase64(f), ...(owner || {}) }));
      } catch (e) { setError(e); }
      setUploading((n) => n - 1);
    }
    if (owner) setSaved((s) => [...(s || []), ...added]);
    else onPendingChange([...(pending || []), ...added]);
  };

  const remove = async (a) => {
    setError(null);
    try {
      await api.del(`/attachments/${a.id}`);
      if (owner) setSaved((s) => s.filter((x) => x.id !== a.id));
      else onPendingChange(pending.filter((x) => x.id !== a.id));
    } catch (e) { setError(e); }
  };

  const extract = async (a) => {
    setError(null); setResult(null); setExtracting(a.id);
    try {
      const r = await api.post(`/attachments/${a.id}/extract`, { type: txnType });
      onExtracted?.(r, a);
      setResult({ ...r, fileName: a.file_name });
    } catch (e) { setError(e); } finally { setExtracting(null); }
  };

  const canExtract = config?.extractionEnabled && onExtracted && !extractDisabled;
  return (
    <div className={`card attachments${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
      <div className="row gap wrap attach-head">
        <Paperclip size={20} className="attach-head-icon" aria-hidden="true" />
        <div className="grow">
          <h3 className="card-title flush">Attachments</h3>
          <div className="muted small">
            {canExtract ? 'Attach a receipt, invoice or other document (drag files here), then use Fill from document to complete the form.' : 'Attach receipts, invoices and other documents (drag files here).'}
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={uploading > 0}><Plus size={15} aria-hidden="true" />{uploading ? 'Uploading…' : 'Attach file'}</button>
        <input ref={input} type="file" multiple hidden accept={config?.extensions.map((x) => `.${x}`).join(',')}
          onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {result && (
        <div className="alert alert-info extract-result">
          <div>
            <strong>Filled in from {result.fileName}.</strong> Check every field before saving.
            {(result.warnings.length > 0 || result.notes) && (
              <ul className="flush">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                {result.notes && <li>Claude’s note: {result.notes}</li>}
              </ul>
            )}
          </div>
          <button type="button" className="link" onClick={() => setResult(null)}>✕</button>
        </div>
      )}
      {!files.length && (
        <button type="button" className="dropzone" onClick={() => input.current?.click()} disabled={uploading > 0}>
          <CloudUpload size={20} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Drag files here or click to browse'}
        </button>
      )}
      {files.length > 0 && (
        <ul className="attach-list">
          {files.map((a) => (
            <li key={a.id}>
              {isImage(a)
                ? <a href={fileUrl(a)} target="_blank" rel="noopener noreferrer"><img className="attach-thumb" src={fileUrl(a)} alt="" /></a>
                : <span className="attach-icon" aria-hidden="true"><FileText size={16} /><span>{a.content_type === 'application/pdf' ? 'PDF' : (a.file_name.split('.').pop() || '').toUpperCase().slice(0, 4)}</span></span>}
              <div className="grow attach-name">
                <a href={fileUrl(a)} target="_blank" rel="noopener noreferrer">{a.file_name}</a>
                <div className="muted small">{size(a.size_bytes)} · {a.created_by || 'Unknown'} · {date(String(a.created_at).slice(0, 10))}{!owner && ' · saved with this record'}</div>
              </div>
              {canExtract && a.can_extract && (
                <button type="button" className="btn btn-sm" disabled={extracting !== null} onClick={() => extract(a)}
                  title="Send this document to Claude and fill in the form from it">
                  <Sparkles size={15} aria-hidden="true" />{extracting === a.id ? 'Reading document…' : 'Fill from document'}
                </button>
              )}
              <a className="btn btn-sm btn-ghost" href={fileUrl(a, true)}><Download size={15} aria-hidden="true" />Download</a>
              <button type="button" className="icon-btn" title="Remove attachment" aria-label="Remove attachment" onClick={() => remove(a)}><X size={16} /></button>
            </li>
          ))}
        </ul>
      )}
      {config && !config.extractionEnabled && onExtracted && isOrgAdmin && files.some((a) => a.can_extract) && (
        <p className="muted small flush">To fill in transactions from documents with Claude, add the organization’s Claude API key under <Link to="/settings">Organization Settings</Link>.</p>
      )}
    </div>
  );
}
