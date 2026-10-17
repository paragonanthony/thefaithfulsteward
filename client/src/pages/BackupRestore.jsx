import React, { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Page } from '../components/ui.jsx';

const readBase64 = (f) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error(`Couldn’t read ${f.name}`));
  r.readAsDataURL(f);
});
const n = (v) => Number(v || 0).toLocaleString();

/** Download the organization's backup (an Excel workbook), and restore one as a new organization or over this one. */
export default function BackupRestore() {
  const { me, refresh, isOrgAdmin } = useApp();
  const orgName = me.currentOrganization?.name || '';
  const sysAdmin = me.user.is_system_admin;
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null); // { name, data, info }
  const [mode, setMode] = useState(sysAdmin ? 'new' : 'replace');
  const [newName, setNewName] = useState('');
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState(null);
  if (!isOrgAdmin) return <Page title="Backup & Restore"><div className="alert alert-warn">Organization administrator access is required.</div></Page>;

  const download = async () => {
    setBusy('download'); setError(null);
    try {
      const res = await fetch(`/api/backup${withFiles ? '?attachments=1' : ''}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Backup failed (${res.status})`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'backup.xlsx';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { setError(e); }
    setBusy(null);
  };

  const choose = async (f) => {
    setFile(null); setDone(null); setError(null); setTyped('');
    if (!f) return;
    setBusy('inspect');
    try {
      const data = await readBase64(f);
      const info = await api.post('/backup/inspect', { data });
      setFile({ name: f.name, data, info });
      setNewName(`${info.organization || 'Organization'} (restored)`);
    } catch (e) { setError(e); }
    setBusy(null);
  };

  const restore = async () => {
    setBusy('restore'); setError(null);
    try {
      const r = mode === 'new'
        ? await api.post('/backup/restore-new', { data: file.data, name: newName })
        : await api.post('/backup/restore', { data: file.data, confirmName: typed });
      setDone({ ...r, mode });
      setFile(null);
      await refresh();
    } catch (e) { setError(e); }
    setBusy(null);
  };

  const openRestored = async () => {
    await api.post('/auth/select-org', { organizationId: done.organizationId });
    window.location.assign('/');
  };

  const info = file?.info;
  const canRestore = file && (mode === 'new' ? newName.trim() : typed.trim().toLowerCase() === orgName.trim().toLowerCase());
  return (
    <Page title="Backup & Restore" subtitle="Keep a copy of everything in this organization, and bring it back when needed">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="card">
        <h2 className="card-title">Back up {orgName}</h2>
        <p>Downloads an Excel workbook with all of this organization’s records: accounts, funds, customers and vendors, every transaction, the general ledger, reconciliations, budgets, reports and settings. Open it in Excel or any spreadsheet program to use the data elsewhere; the <strong>General Ledger</strong> sheet is ready to read, and each other sheet holds one kind of record.</p>
        <p className="muted small">Not included: user sign-ins, bank connection access and the Claude key. After a restore, connect those again.</p>
        <label className="check mt">
          <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
          Include attachments (receipts and other files); the download is then a .zip with the workbook and the files
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={download} disabled={busy === 'download'}>
            <Download size={16} aria-hidden="true" />{busy === 'download' ? 'Preparing…' : 'Download backup'}
          </button>
        </div>
      </div>

      <div className="card mt">
        <h2 className="card-title">Restore a backup</h2>
        {done ? (
          <div className="alert alert-info">
            <div>
              <strong>Restored.</strong> {done.mode === 'new' ? <>The backup is now the organization <strong>{done.name}</strong>.</> : <>{done.name} now holds the backup’s records.</>}
              {done.warnings.length > 0 && <ul className="flush mt">{done.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
              <div className="mt">
                {done.mode === 'new'
                  ? <button type="button" className="btn btn-primary btn-sm" onClick={openRestored}>Open {done.name}</button>
                  : <button type="button" className="btn btn-sm" onClick={() => window.location.assign('/')}>Go to the main menu</button>}
              </div>
            </div>
          </div>
        ) : (
          <>
            <p>Choose a backup file (.xlsx, or the .zip that includes attachments). Backups made by earlier versions of the app can be restored.</p>
            <label className="btn">
              <Upload size={16} aria-hidden="true" />{busy === 'inspect' ? 'Reading…' : 'Choose backup file'}
              <input type="file" accept=".xlsx,.zip" hidden onChange={(e) => { choose(e.target.files[0]); e.target.value = ''; }} />
            </label>
          </>
        )}
        {info && (
          <div className="mt">
            <p><strong>{file.name}</strong>: {info.organization}{info.created && <>, backed up {new Date(info.created).toLocaleString()}</>}{info.createdBy && <> by {info.createdBy}</>}</p>
            <ul className="flush">
              <li>{n(info.counts.transactions)} transactions with {n(info.counts.ledgerLines)} general ledger lines</li>
              <li>{n(info.counts.accounts)} accounts and {n(info.counts.funds)} funds</li>
              <li>{n(info.counts.companies)} customers, donors and vendors</li>
              <li>{n(info.counts.attachments)} attachments{info.counts.attachments > 0 && !info.includesAttachments && ' (their files aren’t in this file; use the .zip backup to restore them)'}</li>
            </ul>
            {info.warnings.length > 0 && <div className="alert alert-warn mt"><ul className="flush">{info.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
            <div className="choice-list mt">
              {sysAdmin && (
                <label className="check">
                  <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} />
                  <span><strong>Restore as a new organization</strong> <span className="muted">(recommended): this organization is left as it is</span></span>
                </label>
              )}
              <label className="check">
                <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                <span><strong>Replace everything in {orgName}</strong> <span className="muted">with the backup. Its users, bank connections and Claude key are kept.</span></span>
              </label>
            </div>
            {mode === 'new' ? (
              <label className="field mt">
                <span className="field-label">Name for the new organization</span>
                <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
            ) : (
              <>
                <div className="alert alert-error mt"><div><strong>Every record now in {orgName} is replaced</strong>, including anything entered since the backup was made. This can’t be undone; download a backup first if you may need the current records.</div></div>
                <label className="field">
                  <span className="field-label">Type <strong>{orgName}</strong> to confirm</span>
                  <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                </label>
              </>
            )}
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => setFile(null)} disabled={busy === 'restore'}>Cancel</button>
              <button type="button" className={`btn ${mode === 'new' ? 'btn-primary' : 'btn-danger'}`} disabled={!canRestore || busy === 'restore'} onClick={restore}>
                {busy === 'restore' ? 'Restoring…' : mode === 'new' ? 'Restore as new organization' : `Replace ${orgName}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}
