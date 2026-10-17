import React from 'react';
import { Link } from 'react-router-dom';
import { longDate } from '../format.js';

/**
 * Closed-period state for a transaction screen.
 * locked: the saved transaction is dated in the closed period (it can't be changed or deleted).
 * dateClosed: the date currently entered is in the closed period (it can't be saved with that date).
 */
export function closedPeriod(closingDate, originalDate, currentDate) {
  const locked = Boolean(closingDate && originalDate && originalDate <= closingDate);
  const dateClosed = Boolean(closingDate && currentDate && currentDate <= closingDate);
  return { closingDate, locked, dateClosed, blocked: locked || dateClosed };
}

export function ClosedPeriodNotice({ state, noun = 'transaction' }) {
  if (state.locked) {
    return (
      <div className="alert alert-warn">
        This {noun} is in a closed period (the books are closed through {longDate(state.closingDate)}), so it can’t be changed or deleted.
        {' '}<Link to="/advanced/period-closing">Period Closing</Link>
      </div>
    );
  }
  if (state.dateClosed) {
    return <div className="alert alert-warn">The date is on or before the period closing date ({longDate(state.closingDate)}). Choose a later date to save.</div>;
  }
  return null;
}
