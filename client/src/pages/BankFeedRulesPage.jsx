import React from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/ui.jsx';
import BankFeedRules from '../components/BankFeedRules.jsx';

// Bank feed rules on their own screen (opened from the Bank Feed); also shown on Bank Feed Setup.
export default function BankFeedRulesPage() {
  return (
    <Page title="Bank Feed Rules" subtitle={<Link to="/bank-feed">Bank Feed</Link>}>
      <BankFeedRules />
    </Page>
  );
}
