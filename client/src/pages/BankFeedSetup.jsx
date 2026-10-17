import React from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/ui.jsx';
import BankConnections from '../components/BankConnections.jsx';
import BankFeedRules from '../components/BankFeedRules.jsx';

// Bank feed setup: live bank connections (which ledger account each bank account feeds) and bank feed rules.
export default function BankFeedSetup() {
  return (
    <Page title="Bank Feed Setup" subtitle={<Link to="/bank-feed">Bank Feed</Link>}>
      <BankConnections />
      <BankFeedRules />
    </Page>
  );
}
