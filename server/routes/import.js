import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { ah } from '../util.js';
import { prepareImport, runImport, undoImport } from '../services/importer.js';
import { prepareListImport, runListImport } from '../services/listImport.js';
import { analyzeQboFiles, runQboFileImport } from '../services/qboFileImport.js';

const r = Router();
r.use(requireAuth, requireOrg);
const ctx = (req) => ({ orgId: req.orgId, userId: req.user.id });

/** Validate rows without saving anything. */
r.post('/transactions/preview', ah(async (req, res) => {
  res.json(await prepareImport({ query }, req.orgId, req.body.rows));
}));

r.post('/transactions', ah(async (req, res) => {
  const result = await withTransaction((db) => runImport(db, ctx(req), req.body.rows, { fileName: req.body.fileName, skipDuplicates: req.body.skipDuplicates !== false }));
  res.status(201).json(result);
}));

// ----- Customers / vendors and the chart of accounts (kind: companies | accounts) -----
const listOpts = (req) => ({ updateExisting: Boolean(req.body.updateExisting) });
r.post('/lists/:kind/preview', ah(async (req, res) => {
  res.json(await prepareListImport({ query }, req.orgId, req.params.kind, req.body.rows, listOpts(req)));
}));
r.post('/lists/:kind', ah(async (req, res) => {
  const result = await withTransaction((db) => runListImport(db, req.orgId, req.params.kind, req.body.rows, listOpts(req)));
  res.status(201).json(result);
}));

// ----- QuickBooks Online report exports (Journal, contact lists, Balance Sheet / P&L / Trial Balance / Account List) -----
const qboOpts = (req) => ({ accounts: req.body.accounts || {}, from: req.body.from || null, to: req.body.to || null });
r.post('/qbo-files/analyze', ah(async (req, res) => {
  res.json(await analyzeQboFiles({ query }, req.orgId, req.body.files, qboOpts(req)));
}));
r.post('/qbo-files', ah(async (req, res) => {
  const result = await withTransaction((db) => runQboFileImport(db, ctx(req), req.body.files, qboOpts(req)));
  res.status(201).json(result);
}));

r.get('/batches', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.kind, b.file_name, b.row_count, cardinality(b.created_account_ids) AS created_accounts, b.created_at, b.undone_at, u.display_name AS created_by, uu.display_name AS undone_by,
            cardinality(b.created_company_ids) AS created_companies,
            (SELECT COUNT(*)::int FROM transactions t WHERE t.import_batch_id = b.id) AS remaining
       FROM import_batches b LEFT JOIN users u ON u.id = b.created_by_user_id LEFT JOIN users uu ON uu.id = b.undone_by_user_id
      WHERE b.organization_id = $1 ORDER BY b.created_at DESC LIMIT 50`,
    [req.orgId],
  );
  res.json(rows);
}));

r.post('/batches/:id/undo', ah(async (req, res) => {
  res.json(await withTransaction((db) => undoImport(db, ctx(req), Number(req.params.id))));
}));

export default r;
