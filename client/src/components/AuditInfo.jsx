import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const when = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "Created … by … · Last updated … by …" for a saved record. refreshKey reloads it after a save. */
export default function AuditInfo({ table, id, refreshKey }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!id || id === 'new') { setInfo(null); return; }
    api.get(`/audit/${table}/${id}`).then(setInfo).catch(() => setInfo(null));
  }, [table, id, refreshKey]);
  if (!info) return null;
  return (
    <p className="audit-info">
      Created {when(info.created_at)}{info.created_by ? ` by ${info.created_by}` : ''}
      {' · '}Last updated {when(info.updated_at)}{info.updated_by ? ` by ${info.updated_by}` : ''}
    </p>
  );
}
