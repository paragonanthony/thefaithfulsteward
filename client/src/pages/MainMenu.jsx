import React from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../App.jsx';
import { Page } from '../components/ui.jsx';
import { iconFor } from '../icons.js';

const TILES = [
  { to: '/guide', title: 'Guide Me', desc: 'Not sure where to start? Answer a few questions to record income, expenses, bills and deposits step by step.' },
  { to: '/income', title: 'Deposits and Income', desc: 'Record income and donations, then group them into bank deposits.' },
  { to: '/expenses', title: 'Expenses', desc: 'Record checks, card charges and electronic payments.' },
  { to: '/bills', title: 'Bills', desc: 'Enter bills you owe vendors, then pay one or several with a single check or payment.' },
  { to: '/companies', title: 'Customers, Donors and Vendors', desc: 'Names, addresses and default accounts.' },
  { to: '/setup', title: 'Account & Fund Setup', desc: 'Chart of accounts, funds and account groups.' },
  { to: '/register', title: 'Bank Account Registers', desc: 'Running balance of each bank and card account.' },
  { to: '/reconcile', title: 'Reconcile Accounts', desc: 'Match your records to bank statements.' },
  { to: '/bank-feed', title: 'Bank Feeds', desc: 'Import bank activity and match it to transactions.' },
  { to: '/reports', title: 'Reports', desc: 'Profit & Loss, Balance Sheet, by-fund reports and the report designer.' },
  { to: '/budgets', title: 'Budgets', desc: 'Overall and fund budgets by month, compared to actuals in Budget to Actual reports.' },
  { to: '/tuition', title: 'Tuition', desc: 'Tuition owed by customers, payments received and balances due.', feature: 'tuition_enabled' },
  { to: '/advanced', title: 'Advanced', desc: 'Journal entries and other tools that work directly with the general ledger.' },
  { to: '/users', title: 'User Setup', desc: 'Who can access this organization.', admin: true },
];

export default function MainMenu() {
  const { me, isOrgAdmin } = useApp();
  return (
    <Page title={me.currentOrganization.name} subtitle="Main Menu">
      <div className="tiles">
        {TILES.filter((t) => (!t.admin || isOrgAdmin) && (!t.feature || me.currentOrganization[t.feature])).map((t) => {
          const Icon = iconFor(t.to);
          return (
          <Link key={t.to} to={t.to} className="tile">
            <span className="tile-title">{Icon && <span className="tile-icon" aria-hidden="true"><Icon size={18} /></span>}{t.title}</span>
            <span className="tile-desc">{t.desc}</span>
          </Link>
          );
        })}
      </div>
    </Page>
  );
}
