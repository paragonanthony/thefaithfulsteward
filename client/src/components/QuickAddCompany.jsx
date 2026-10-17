import React, { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, Modal, useAccountOptions } from './ui.jsx';

/**
 * Create a customer/donor/vendor without leaving a transaction.
 * kind: 'income' | 'expense' decides which default account is offered.
 */
export default function QuickAddCompany({ kind, initialName = '', initialAccountId = null, onCreated, onClose }) {
  const { reloadLookups } = useApp();
  const isIncome = kind === 'income';
  const [c, setC] = useState({ name: initialName, email: '', phone1: '', accountId: initialAccountId });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const accountOptions = useAccountOptions(() => true);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post('/companies', {
        name: c.name,
        email: c.email,
        phone1: c.phone1,
        [isIncome ? 'default_income_account_id' : 'default_expense_account_id']: c.accountId,
      });
      await reloadLookups();
      onCreated(created);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={isIncome ? 'New Customer / Donor' : 'New Vendor'} onClose={onClose} width={520}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !c.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <ErrorBanner error={error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (c.name.trim()) save(); }}>
        <Field label="Name" required><input className="input" autoFocus value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
        <div className="grid g2">
          <Field label="Email"><input className="input" type="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={c.phone1} onChange={(e) => setC({ ...c, phone1: e.target.value })} /></Field>
        </div>
        <Field label={isIncome ? 'Default Income Account' : 'Default Expense Account'} hint="Filled in automatically the next time you choose this name">
          <Combo options={accountOptions} value={c.accountId} onChange={(v) => setC({ ...c, accountId: v })} />
        </Field>
        <p className="muted small">Address and other details can be added later under Customers, Donors &amp; Vendors.</p>
        <button hidden />
      </form>
    </Modal>
  );
}
