import React from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/ui.jsx';

const TILES = [
  { to: '/advanced/journal-entries', title: 'Journal Entries', desc: 'Post debits and credits directly to the general ledger: accruals, corrections, reclassifications and transfers.' },
  { to: '/advanced/backup', title: 'Backup & Restore', desc: 'Download all of this organization’s records as an Excel workbook, or restore a backup.' },
  { to: '/advanced/period-closing', title: 'Period Closing', desc: 'Lock the books through a date so earlier transactions can no longer be added, changed or deleted.' },
  { to: '/advanced/quickbooks-files', title: 'QuickBooks Export Import', desc: 'Bring in a QuickBooks Online company from its report exports (Journal, Balance Sheet, Profit and Loss, customer and vendor lists), no connection needed.' },
  { to: '/advanced/import/accounts', title: 'Import Chart of Accounts', desc: 'Add or update accounts from a CSV or Excel file: number, name, type, group, default fund.' },
  { to: '/advanced/import/customers', title: 'Import Customers & Vendors', desc: 'Add or update customers, donors and vendors from a CSV or Excel file, with addresses and default accounts.' },
  { to: '/advanced/import', title: 'Import Transactions', desc: 'Bring in income and expenses from a CSV or Excel file, one transaction per row, with a check before anything is saved.' },
];

/** Tools for users comfortable working with debits and credits. */
export default function Advanced() {
  return (
    <Page title="Advanced" subtitle="Accounting tools that work directly with the general ledger">
      <div className="tiles">
        {TILES.map((t) => (
          <Link key={t.to} to={t.to} className="tile">
            <span className="tile-title">{t.title}</span>
            <span className="tile-desc">{t.desc}</span>
          </Link>
        ))}
      </div>
    </Page>
  );
}
