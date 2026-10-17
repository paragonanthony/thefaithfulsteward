// MCP server (Streamable HTTP, stateless) at /mcp. Clients sign in with the user's own account (OAuth, see
// server/oauth.js). Every tool calls this app's own REST API with the caller's token, so a tool can see and change
// exactly what that user can in the web app: the same organizations, roles, validation and closed-period rules.
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireAuth } from './auth.js';
import { publicBase } from './oauth.js';

const TXN_PATHS = { income: '/income', expense: '/expenses', bill: '/bills', deposit: '/deposits', journal: '/journal-entries', transfer: '/transfers' };
const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Calls this server's /api as the signed-in user. */
function apiClient(req) {
  const base = `http://127.0.0.1:${req.socket.localPort}/api`;
  return async (method, path, { body, org } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: req.get('authorization'), 'Content-Type': 'application/json', ...(org ? { 'X-Organization-Id': String(org) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  };
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); } catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] }; }
};

const org = z.number().int().optional().describe('Organization id (from list_organizations). Needed only when you belong to more than one.');
const ref = (what) => z.union([z.number().int(), z.string()]).describe(`${what}: its id, or its exact name${what.includes('ccount') ? ' or account number' : ''}`);
const day = (what) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`${what} (YYYY-MM-DD)`);

/** Resolve names / numbers to ids using the organization's lists. */
async function resolver(api, orgId) {
  const lk = await api('GET', '/lookups', { org: orgId });
  const find = (list, value, label, keyFns) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') {
      if (!list.some((x) => x.id === value)) throw new Error(`${label} ${value} was not found`);
      return value;
    }
    for (const key of keyFns) {
      const hits = list.filter((x) => norm(key(x)) === norm(value));
      if (hits.length === 1) return hits[0].id;
      if (hits.length > 1) throw new Error(`More than one ${label.toLowerCase()} matches "${value}"; use its id`);
    }
    const near = list.filter((x) => keyFns.some((k) => norm(k(x)).includes(norm(value)))).slice(0, 5).map((x) => `${x.id}: ${keyFns.map((k) => k(x)).filter(Boolean).join(' ')}`);
    throw new Error(`${label} "${value}" was not found${near.length ? `. Close matches: ${near.join('; ')}` : ''}`);
  };
  return {
    lookups: lk,
    account: (v) => find(lk.accounts, v, 'Account', [(a) => a.account_number, (a) => a.name]),
    company: (v) => find(lk.companies, v, 'Customer / vendor', [(c) => c.name]),
    fund: (v) => find(lk.funds, v, 'Fund', [(f) => f.name]),
  };
}

function buildServer(req) {
  const api = apiClient(req);
  const server = new McpServer({ name: 'the-faithful-steward', version: '1.0.0' }, {
    instructions: 'Accounting for non-profit organizations (The Faithful Steward). You act as the signed-in user, with their permissions. '
      + 'Use list_organizations first when the user belongs to several organizations, and pass organization_id. '
      + 'Look up accounts, funds and names before creating transactions. Amounts are in dollars; dates are YYYY-MM-DD.',
  });
  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool('list_organizations', {
    title: 'List organizations', description: 'The organizations you can use, with your role in each.', inputSchema: {}, annotations: read,
  }, wrap(async () => {
    const me = await api('GET', '/auth/me');
    return { user: me.user.display_name || me.user.username, organizations: me.organizations.map((o) => ({ id: o.id, name: o.name, role: o.role })) };
  }));

  server.registerTool('get_chart_of_accounts', {
    title: 'Chart of accounts and funds', description: 'All accounts (id, number, name, type, active, default fund) and funds.', inputSchema: { organization_id: org }, annotations: read,
  }, wrap(async ({ organization_id }) => {
    const lk = await api('GET', '/lookups', { org: organization_id });
    return {
      accounts: lk.accounts.map((a) => ({ id: a.id, number: a.account_number, name: a.name, type: a.account_type, active: a.is_active, default_fund_id: a.default_fund_id, undeposited_funds: a.is_undeposited_funds || undefined })),
      funds: lk.funds.map((f) => ({ id: f.id, name: f.name, restricted: f.is_restricted, active: f.is_active })),
    };
  }));

  server.registerTool('find_customers_vendors', {
    title: 'Find customers, donors and vendors', description: 'Search names by name, email, phone, city or address (500 per page).',
    inputSchema: { search: z.string().optional(), page: z.number().int().min(1).optional(), organization_id: org }, annotations: read,
  }, wrap(async ({ search, page, organization_id }) => {
    const q = new URLSearchParams({ page: String(page || 1), ...(search ? { search } : {}) });
    const r = await api('GET', `/companies?${q}`, { org: organization_id });
    return { total: r.total, page: r.page, rows: r.rows.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone1, city: c.city, active: c.is_active })) };
  }));

  server.registerTool('create_customer_vendor', {
    title: 'Create a customer, donor or vendor', description: 'Add a name. Default accounts are optional (income for customers / donors, expense for vendors).',
    inputSchema: {
      name: z.string().min(1), email: z.string().optional(), phone: z.string().optional(), address1: z.string().optional(), city: z.string().optional(),
      state: z.string().optional(), postal: z.string().optional(), notes: z.string().optional(),
      default_income_account: ref('Default income account').optional(), default_expense_account: ref('Default expense account').optional(), organization_id: org,
    },
    annotations: write,
  }, wrap(async (a) => {
    const r = await resolver(api, a.organization_id);
    return api('POST', '/companies', {
      org: a.organization_id,
      body: {
        name: a.name, email: a.email, phone1: a.phone, address1: a.address1, city: a.city, state: a.state, postal: a.postal, notes: a.notes,
        default_income_account_id: r.account(a.default_income_account), default_expense_account_id: r.account(a.default_expense_account),
      },
    });
  }));

  server.registerTool('list_transactions', {
    title: 'List transactions', description: 'Income, expenses, bills, deposits or journal entries, newest first, 500 per page, with the total over all pages.',
    inputSchema: {
      type: z.enum(['income', 'expense', 'bill', 'deposit', 'journal']), from: day('From date').optional(), to: day('To date').optional(),
      search: z.string().optional().describe('Name, number, memo or amount'), bill_status: z.enum(['open', 'paid', 'all']).optional().describe('Bills only (default open)'),
      page: z.number().int().min(1).optional(), organization_id: org,
    },
    annotations: read,
  }, wrap(async (a) => {
    const q = new URLSearchParams({ page: String(a.page || 1) });
    if (a.from) q.set('from', a.from);
    if (a.to) q.set('to', a.to);
    if (a.search) q.set('search', a.search);
    if (a.type === 'bill') q.set('status', a.bill_status || 'open');
    const r = await api('GET', `${TXN_PATHS[a.type]}?${q}`, { org: a.organization_id });
    return { total: r.total, page: r.page, pageSize: r.pageSize, totals: r.totals, rows: r.rows };
  }));

  server.registerTool('get_transaction', {
    title: 'Get a transaction', description: 'One transaction with its lines and general ledger entries.',
    inputSchema: { type: z.enum(['income', 'expense', 'bill', 'deposit', 'journal', 'transfer']), id: z.number().int(), organization_id: org }, annotations: read,
  }, wrap(({ type, id, organization_id }) => api('GET', `${TXN_PATHS[type]}/${id}`, { org: organization_id })));

  const lineSchema = z.object({
    account: ref('Account'), amount: z.number().positive(), fund: ref('Fund').optional(), memo: z.string().optional(),
  });
  for (const type of ['income', 'expense']) {
    server.registerTool(`create_${type}`, {
      title: type === 'income' ? 'Record income' : 'Record an expense',
      description: type === 'income'
        ? 'Record money received into a bank account (or Undeposited Funds), split across income lines. Use a check number for a check received.'
        : 'Record money paid from a bank or credit card account, split across expense lines. Use a check number to record a check.',
      inputSchema: {
        date: day('Date'), bank_account: ref(type === 'income' ? 'Deposit-to account' : 'Bank or card account'),
        customer_vendor: ref(type === 'income' ? 'Customer / donor' : 'Vendor').optional(), lines: z.array(lineSchema).min(1),
        memo: z.string().optional(), check_number: z.string().optional(), ref_number: z.string().optional(), organization_id: org,
      },
      annotations: write,
    }, wrap(async (a) => {
      const r = await resolver(api, a.organization_id);
      const lines = a.lines.map((l) => ({ accountId: r.account(l.account), amount: l.amount.toFixed(2), fundId: r.fund(l.fund), memo: l.memo || null }));
      const amount = a.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100;
      const res = await api('POST', TXN_PATHS[type], {
        org: a.organization_id,
        body: {
          date: a.date, amount: amount.toFixed(2), accountId: r.account(a.bank_account), companyId: r.company(a.customer_vendor), memo: a.memo || null,
          method: a.check_number ? 'check' : 'electronic', checkNumber: a.check_number || null, refNumber: a.ref_number || null, lines,
        },
      });
      return { created: type, id: res.id, amount: amount.toFixed(2) };
    }));
  }

  server.registerTool('create_journal_entry', {
    title: 'Create a journal entry', description: 'Post debits and credits directly. Each line is a debit or a credit; total debits must equal total credits.',
    inputSchema: {
      date: day('Date'), memo: z.string().optional(), organization_id: org,
      lines: z.array(z.object({ account: ref('Account'), debit: z.number().positive().optional(), credit: z.number().positive().optional(), fund: ref('Fund').optional(), memo: z.string().optional() })).min(2),
    },
    annotations: write,
  }, wrap(async (a) => {
    const r = await resolver(api, a.organization_id);
    const res = await api('POST', '/journal-entries', {
      org: a.organization_id,
      body: { date: a.date, memo: a.memo || null, lines: a.lines.map((l) => ({ accountId: r.account(l.account), debit: l.debit ? l.debit.toFixed(2) : '', credit: l.credit ? l.credit.toFixed(2) : '', fundId: r.fund(l.fund), memo: l.memo || null })) },
    });
    return { created: 'journal', id: res.id };
  }));

  server.registerTool('create_transfer', {
    title: 'Transfer between bank accounts', description: 'Move money between two bank or credit card accounts (e.g. savings to checking, or paying a card).',
    inputSchema: { date: day('Date'), from_account: ref('From account'), to_account: ref('To account'), amount: z.number().positive(), memo: z.string().optional(), organization_id: org },
    annotations: write,
  }, wrap(async (a) => {
    const r = await resolver(api, a.organization_id);
    const res = await api('POST', '/transfers', { org: a.organization_id, body: { date: a.date, fromAccountId: r.account(a.from_account), toAccountId: r.account(a.to_account), amount: a.amount.toFixed(2), memo: a.memo || null } });
    return { created: 'transfer', id: res.id };
  }));

  server.registerTool('bank_register', {
    title: 'Bank account register', description: 'A bank or card account\'s activity with running balance, and its beginning and ending balances.',
    inputSchema: { bank_account: ref('Bank or card account'), from: day('From date').optional(), to: day('To date').optional(), organization_id: org }, annotations: read,
  }, wrap(async (a) => {
    const r = await resolver(api, a.organization_id);
    const q = new URLSearchParams({ accountId: String(r.account(a.bank_account)) });
    if (a.from) q.set('from', a.from);
    if (a.to) q.set('to', a.to);
    return api('GET', `/register?${q}`, { org: a.organization_id });
  }));

  server.registerTool('list_reports', {
    title: 'List reports', description: 'The organization\'s reports (standard and custom), with their ids.', inputSchema: { organization_id: org }, annotations: read,
  }, wrap(async ({ organization_id }) => (await api('GET', '/reports', { org: organization_id })).map((x) => ({ id: x.id, name: x.name, description: x.description, type: x.type, standard: Boolean(x.builtin_key) }))));

  server.registerTool('run_report', {
    title: 'Run a report', description: 'Run a report (Profit and Loss, Balance Sheet, by fund, budget to actual, Trial Balance, Unpaid Bills Aging, ...) for a period or as of a date.',
    inputSchema: {
      report: z.union([z.number().int(), z.string()]).describe('Report id or exact name (see list_reports)'),
      from: day('Period start').optional(), to: day('Period end, or the "as of" date for balance reports').optional(), organization_id: org,
    },
    annotations: read,
  }, wrap(async (a) => {
    const reports = await api('GET', '/reports', { org: a.organization_id });
    const rep = typeof a.report === 'number' ? reports.find((x) => x.id === a.report) : reports.find((x) => norm(x.name) === norm(a.report));
    if (!rep) throw new Error(`Report "${a.report}" was not found. Reports: ${reports.map((x) => x.name).join(', ')}`);
    const { definition } = await api('GET', `/reports/${rep.id}`, { org: a.organization_id });
    const to = a.to || new Date().toISOString().slice(0, 10);
    const result = await api('POST', '/reports/run', { org: a.organization_id, body: { definition, from: a.from, to } });
    return { report: rep.name, ...result };
  }));

  server.registerTool('list_bank_feed', {
    title: 'Bank feed lines', description: 'Imported bank lines for an account (unmatched, matched or ignored), 500 per page, with suggested matches and assigned customer / vendor and account.',
    inputSchema: { bank_account: ref('Bank or card account'), status: z.enum(['unmatched', 'matched', 'ignored']).optional(), page: z.number().int().min(1).optional(), organization_id: org },
    annotations: read,
  }, wrap(async (a) => {
    const r = await resolver(api, a.organization_id);
    const q = new URLSearchParams({ accountId: String(r.account(a.bank_account)), status: a.status || 'unmatched', page: String(a.page || 1) });
    return api('GET', `/bank-feed?${q}`, { org: a.organization_id });
  }));

  server.registerTool('assign_bank_feed_line', {
    title: 'Set a bank line\'s customer / vendor and account', description: 'Choose the customer / vendor and the account for an unmatched bank feed line (used by quick_add_bank_feed_line).',
    inputSchema: { line_id: z.number().int(), customer_vendor: ref('Customer / vendor').optional(), account: ref('Account').optional(), organization_id: org }, annotations: write,
  }, wrap(async (a) => {
    const r = await resolver(api, a.organization_id);
    return api('PUT', `/bank-feed/${a.line_id}/assign`, { org: a.organization_id, body: { companyId: r.company(a.customer_vendor), accountId: r.account(a.account) } });
  }));

  server.registerTool('quick_add_bank_feed_line', {
    title: 'Quick Add a bank line', description: 'Create the income (money in) or expense (money out) for an unmatched bank feed line from its account and customer / vendor, and match it. The line needs an account.',
    inputSchema: { line_id: z.number().int(), organization_id: org }, annotations: write,
  }, wrap(({ line_id, organization_id }) => api('POST', `/bank-feed/${line_id}/quick-add`, { org: organization_id })));

  server.registerTool('match_bank_feed_line', {
    title: 'Match a bank line to a transaction', description: 'Match an unmatched bank feed line to an existing transaction (see the line\'s suggestions).',
    inputSchema: { line_id: z.number().int(), transaction_id: z.number().int(), organization_id: org }, annotations: write,
  }, wrap(({ line_id, transaction_id, organization_id }) => api('POST', `/bank-feed/${line_id}/match`, { org: organization_id, body: { transactionId: transaction_id } })));

  return server;
}

export const mcpRoutes = Router();

/** MCP needs a bearer token (never the browser's cookie); without one, point the client at the sign-in. */
mcpRoutes.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const challenge = (error) => res.set('WWW-Authenticate', `Bearer resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ''}`);
  if (!/^Bearer\s+\S/i.test(req.get('authorization') || '')) {
    challenge();
    return res.status(401).json({ error: 'Sign in required' });
  }
  requireAuth(req, res, (err) => {
    if (!err) return next();
    if (err.status === 401) challenge('invalid_token');
    return res.status(err.status || 500).json({ error: err.message });
  });
});

mcpRoutes.post('/', async (req, res) => {
  const server = buildServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
// Stateless server: no server-initiated streams or sessions.
mcpRoutes.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
mcpRoutes.delete('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
