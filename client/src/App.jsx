import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import SelectOrg from './pages/SelectOrg.jsx';
import MainMenu from './pages/MainMenu.jsx';
import Companies from './pages/Companies.jsx';
import CompanyEdit from './pages/CompanyEdit.jsx';
import TxnList from './pages/TxnList.jsx';
import TxnEdit from './pages/TxnEdit.jsx';
import DepositList from './pages/DepositList.jsx';
import DepositEdit from './pages/DepositEdit.jsx';
import Register from './pages/Register.jsx';
import ReconcileList from './pages/ReconcileList.jsx';
import ReconcileEdit from './pages/ReconcileEdit.jsx';
import AccountSetup from './pages/AccountSetup.jsx';
import AccountEdit from './pages/AccountEdit.jsx';
import CheckFormatEdit from './pages/CheckFormatEdit.jsx';
import ReceiptTemplateEdit from './pages/ReceiptTemplateEdit.jsx';
import BankFeed from './pages/BankFeed.jsx';
import BankFeedSetup from './pages/BankFeedSetup.jsx';
import BankFeedRulesPage from './pages/BankFeedRulesPage.jsx';
import Reports from './pages/Reports.jsx';
import ReportView from './pages/ReportView.jsx';
import ReportDesigner from './pages/ReportDesigner.jsx';
import UserSetup from './pages/UserSetup.jsx';
import Organizations from './pages/Organizations.jsx';
import OrgSettings from './pages/OrgSettings.jsx';
import Account from './pages/Account.jsx';
import ConnectApp from './pages/ConnectApp.jsx';
import GuideMe from './pages/GuideMe.jsx';
import PrintTxn from './pages/PrintTxn.jsx';
import Tuition from './pages/Tuition.jsx';
import Advanced from './pages/Advanced.jsx';
import JournalList from './pages/JournalList.jsx';
import JournalEdit from './pages/JournalEdit.jsx';
import ImportTransactions from './pages/ImportTransactions.jsx';
import ImportList from './pages/ImportList.jsx';
import PeriodClosing from './pages/PeriodClosing.jsx';
import TransferEdit from './pages/TransferEdit.jsx';
import Budgets from './pages/Budgets.jsx';
import Bills from './pages/Bills.jsx';
import PayBills from './pages/PayBills.jsx';
import QboFileImport from './pages/QboFileImport.jsx';
import BackupRestore from './pages/BackupRestore.jsx';
import ReconcileReport from './pages/ReconcileReport.jsx';
import ChangePasswordRequired from './pages/ChangePasswordRequired.jsx';
import BudgetEdit from './pages/BudgetEdit.jsx';
import TuitionEdit from './pages/TuitionEdit.jsx';
import TuitionBulk from './pages/TuitionBulk.jsx';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [lookups, setLookups] = useState(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get('/auth/me'));
    } catch {
      setMe(null);
    }
  }, []);

  const reloadLookups = useCallback(async () => {
    try {
      setLookups(await api.get('/lookups'));
    } catch {
      setLookups(null);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const expired = () => setMe(null);
    const noOrg = () => { refresh(); navigate('/'); };
    window.addEventListener('auth:expired', expired);
    window.addEventListener('auth:no-org', noOrg);
    // An administrator required a new password while this user was signed in: show the change-password screen.
    window.addEventListener('auth:password-change', refresh);
    return () => {
      window.removeEventListener('auth:expired', expired);
      window.removeEventListener('auth:no-org', noOrg);
      window.removeEventListener('auth:password-change', refresh);
    };
  }, [refresh, navigate]);

  const orgId = me?.currentOrganization?.id;
  useEffect(() => {
    setLookups(null);
    if (orgId) reloadLookups();
  }, [orgId, reloadLookups]);

  if (me === undefined) return <div className="boot">Loading…</div>;
  if (!me) return <Login onLogin={refresh} />;
  if (me.user.must_change_password) return <ChangePasswordRequired me={me} onDone={refresh} />;
  // Approving an app that asked to use this account (API / MCP sign-in); shown right after signing in.
  if (window.location.pathname === '/connect-app') return <ConnectApp />;

  const ctx = { me, refresh, lookups, reloadLookups, isOrgAdmin: me.currentOrganization?.role === 'admin' || me.user.is_system_admin };

  if (!me.currentOrganization) {
    return (
      <AppContext.Provider value={ctx}>
        <Routes>
          <Route path="/admin/organizations" element={<Layout bare><Organizations /></Layout>} />
          <Route path="*" element={<SelectOrg />} />
        </Routes>
      </AppContext.Provider>
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      <Routes>
        <Route path="/print/:kind/:id" element={<PrintTxn />} />
        <Route element={<Layout />}>
          <Route path="/" element={<MainMenu />} />
          <Route path="/select-org" element={<SelectOrg embedded />} />
          <Route path="/guide" element={<GuideMe />} />
          <Route path="/guide/:kind" element={<GuideMe />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<CompanyEdit />} />
          <Route path="/income" element={<TxnList type="income" />} />
          <Route path="/income/:id" element={<TxnEdit type="income" />} />
          <Route path="/expenses" element={<TxnList type="expense" />} />
          <Route path="/expenses/:id" element={<TxnEdit type="expense" />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/bills/pay" element={<PayBills />} />
          <Route path="/bills/:id" element={<TxnEdit type="bill" key="bill" />} />
          <Route path="/deposits" element={<DepositList />} />
          <Route path="/deposits/:id" element={<DepositEdit />} />
          <Route path="/register" element={<Register />} />
          <Route path="/register/transfers/:id" element={<TransferEdit />} />
          <Route path="/reconcile" element={<ReconcileList />} />
          <Route path="/reconcile/:id" element={<ReconcileEdit />} />
          <Route path="/reconcile/:id/report" element={<ReconcileReport />} />
          <Route path="/setup" element={<AccountSetup />} />
          <Route path="/setup/accounts/:id" element={<AccountEdit />} />
          <Route path="/setup/check-formats/:id" element={<CheckFormatEdit />} />
          <Route path="/setup/receipts/:id" element={<ReceiptTemplateEdit />} />
          <Route path="/bank-feed" element={<BankFeed />} />
          <Route path="/bank-feed/setup" element={<BankFeedSetup />} />
          <Route path="/bank-feed/rules" element={<BankFeedRulesPage />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/:id" element={<ReportView />} />
          <Route path="/reports/:id/design" element={<ReportDesigner />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/budgets/:id" element={<BudgetEdit />} />
          <Route path="/tuition" element={<Tuition />} />
          <Route path="/tuition/bulk" element={<TuitionBulk />} />
          <Route path="/tuition/:id" element={<TuitionEdit />} />
          <Route path="/advanced" element={<Advanced />} />
          <Route path="/advanced/journal-entries" element={<JournalList />} />
          <Route path="/advanced/journal-entries/:id" element={<JournalEdit />} />
          <Route path="/advanced/import" element={<ImportTransactions />} />
          <Route path="/advanced/import/customers" element={<ImportList key="companies" kind="companies" />} />
          <Route path="/advanced/import/accounts" element={<ImportList key="accounts" kind="accounts" />} />
          <Route path="/advanced/period-closing" element={<PeriodClosing />} />
          <Route path="/advanced/quickbooks-files" element={<QboFileImport />} />
          <Route path="/advanced/backup" element={<BackupRestore />} />
          <Route path="/users" element={<UserSetup />} />
          <Route path="/settings" element={<OrgSettings />} />
          <Route path="/account" element={<Account />} />
          <Route path="/admin/organizations" element={<Organizations />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppContext.Provider>
  );
}
