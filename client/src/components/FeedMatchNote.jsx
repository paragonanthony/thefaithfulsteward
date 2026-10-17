import React from 'react';
import { Link } from 'react-router-dom';
import { date, money } from '../format.js';

const SOURCE = { simplefin: 'bank connection', stripe: 'bank connection', plaid: 'bank connection', file: 'statement import' };

/** Caption on a transaction screen: the bank feed line(s) this transaction is matched to. */
export default function FeedMatchNote({ matches }) {
  if (!matches?.length) return null;
  return (
    <div className="feed-match-note">
      {matches.map((m) => (
        <div key={m.id}>
          <span className="feed-match-icon" aria-hidden="true">⇄</span>
          Matched to a bank feed line in <strong>{m.account_name}</strong>: {date(m.date)} · {m.description || 'No description'} ·{' '}
          <span className={Number(m.amount) < 0 ? 'neg' : ''}>{money(m.amount)}</span>
          <span className="muted"> (from a {SOURCE[m.source] || 'statement import'}{m.matched_at ? `; matched ${date(String(m.matched_at).slice(0, 10))}${m.matched_by ? ` by ${m.matched_by}` : ''}` : ''})</span>
          {' '}<Link to={`/bank-feed?account=${m.account_id}&status=matched`}>View in bank feed</Link>
        </div>
      ))}
    </div>
  );
}
