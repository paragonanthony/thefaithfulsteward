import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPg from 'connect-pg-simple';
import helmet from 'helmet';
import { pool, query, requestContext } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword } from './auth.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import setupRoutes from './routes/setup.js';
import transactionRoutes from './routes/transactions.js';
import reconcileRoutes from './routes/reconcile.js';
import bankFeedRoutes from './routes/bankfeed.js';
import bankFeedRuleRoutes from './routes/bankFeedRules.js';
import reportRoutes from './routes/reports.js';
import bankConnectionRoutes from './routes/bankConnections.js';
import { oauthAccountRoutes, oauthRoutes } from './oauth.js';
import { mcpRoutes } from './mcp.js';
import checkFormatRoutes from './routes/checkFormats.js';
import receiptTemplateRoutes from './routes/receiptTemplates.js';
import receiptRoutes from './routes/receipts.js';
import tuitionRoutes from './routes/tuition.js';
import importRoutes from './routes/import.js';
import periodClosingRoutes from './routes/periodClosing.js';
import budgetRoutes from './routes/budgets.js';
import attachmentRoutes from './routes/attachments.js';
import backupRoutes from './routes/backup.js';
import { isConfigured as simplefinConfigured, syncAllConnections } from './services/simplefin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isProd = process.env.NODE_ENV === 'production';

/** Create the first system administrator when none exists. */
async function bootstrapAdmin() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users WHERE is_system_admin');
  if (rows[0].n > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.log(`\n*** Created system administrator "${username}" with temporary password: ${password}\n*** Sign in and change it, or set ADMIN_PASSWORD before first start.\n`);
  }
  await query('INSERT INTO users (username, password_hash, display_name, is_system_admin) VALUES ($1,$2,$3,true)', [username, await hashPassword(password), 'Administrator']);
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Railway terminates TLS at its proxy
  app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:'] } } }));
  // File uploads arrive as base64 JSON, so they get a larger limit (10 MB files) than other API calls.
  app.use('/api/attachments', express.json({ limit: '15mb' }));
  app.use('/api/import/qbo-files', express.json({ limit: '60mb' })); // several QuickBooks report exports at once
  app.use('/api/bank-feed/extract-statement', express.json({ limit: '15mb' }));
  app.use('/api/reconciliations/extract-statement', express.json({ limit: '15mb' }));
  app.use('/api/backup', express.json({ limit: '400mb' })); // a backup file, with its attachments
  app.use(express.json({ limit: '5mb' }));

  const PgStore = connectPg(session);
  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (isProd) console.warn('WARNING: SESSION_SECRET is not set; sessions will not survive restarts.');
    secret = crypto.randomBytes(32).toString('hex');
  }
  app.use(session({
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
    secret,
    name: 'npacct.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 8 },
  }));

  // Every database write made while handling a request records the signed-in user (see migrations/011_audit_fields.sql).
  app.use((req, res, next) => requestContext.run({ userId: req.session?.userId || null }, next));

  // CSRF defence in depth: state-changing API calls must be JSON (forms can't send it cross-site).
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['content-type'] && !/^application\/json/i.test(req.headers['content-type'])) {
      return next(new HttpError(415, 'Requests must be JSON'));
    }
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  // API / MCP sign-in (OAuth) and the MCP server
  app.use(oauthRoutes);
  app.use('/api/oauth', oauthAccountRoutes);
  app.use('/mcp', mcpRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  // Mounted before the /api routers that require a session for every request.
  app.use('/api/bank-connections', bankConnectionRoutes);
  app.use('/api', setupRoutes);
  app.use('/api', transactionRoutes);
  app.use('/api/reconciliations', reconcileRoutes);
  app.use('/api/bank-feed', bankFeedRoutes);
  app.use('/api/bank-feed-rules', bankFeedRuleRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/check-formats', checkFormatRoutes);
  app.use('/api/receipt-templates', receiptTemplateRoutes);
  app.use('/api/receipts', receiptRoutes);
  app.use('/api/tuition', tuitionRoutes);
  app.use('/api/import', importRoutes);
  app.use('/api/period-closing', periodClosingRoutes);
  app.use('/api/budgets', budgetRoutes);
  app.use('/api/attachments', attachmentRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

  const dist = path.join(root, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err.code === 'P0001' && (err.hint === 'period_closed' || err.hint === 'reconciled_locked')) { status = 409; message = err.message; }
    else if (err.code === '23505') { status = 409; message = 'A record with that value already exists'; }
    else if (err.code === '23503') { status = 409; message = 'This record is in use and cannot be removed'; }
    else if (!(err instanceof HttpError) && !(err.status >= 400 && err.status < 500)) { console.error(err); status = 500; message = 'An unexpected error occurred'; }
    res.status(status).json({ error: message, ...(err instanceof HttpError && typeof err.code === 'string' ? { code: err.code } : {}) });
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await migrate();
  await bootstrapAdmin();
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`The Faithful Steward listening on port ${port}`));
  if (simplefinConfigured()) {
    // SimpleFIN servers refresh bank data about once a day and limit requests, so a few syncs a day is plenty.
    const hours = Number(process.env.SIMPLEFIN_SYNC_INTERVAL_HOURS || 6);
    setTimeout(syncAllConnections, 60 * 1000);
    setInterval(syncAllConnections, hours * 60 * 60 * 1000);
    console.log(`SimpleFIN bank feeds enabled; background sync every ${hours}h`);
  }
}
