import { ACCOUNT_TYPES, TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError } from '../util.js';
import { normalizeTuitionDefinition, runTuitionReport } from './tuitionReports.js';
import { normalizeTrialBalanceDefinition, runTrialBalance } from './trialBalance.js';
import { budgetAmounts, defaultBudgetId, loadBudget } from './budgets.js';
import { normalizeBillAgingDefinition, runBillAging } from './billAging.js';
import {
  addDays, addMonths, fiscalQuarterStart, fiscalYearStart, maxDate, minDate,
  monthEnd, monthLabel, monthStart, parts, prettyDate,
} from './dates.js';

const MAX_COLUMNS = 60;
const NO_FUND = 'none';
const fundKey = (fundId) => (fundId === null || fundId === undefined ? NO_FUND : String(fundId));

// ---------------------------------------------------------------------------
// Formula parsing: supports + - * / parentheses, numbers and row ids.
// ---------------------------------------------------------------------------
export function parseFormula(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))/y;
  let pos = 0;
  const text = String(src || '');
  while (pos < text.length) {
    if (/^\s*$/.test(text.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) throw new HttpError(400, `Invalid formula "${text}" near "${text.slice(pos).trim()}"`);
    pos = re.lastIndex;
    if (m[1]) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'op', v: m[3] });
  }
  let i = 0;
  const peek = () => tokens[i];
  const expect = (v) => {
    const tok = tokens[i++];
    if (!tok || tok.v !== v) throw new HttpError(400, `Invalid formula "${text}": expected "${v}"`);
  };
  function expr() {
    let node = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) node = { op: tokens[i++].v, a: node, b: term() };
    return node;
  }
  function term() {
    let node = factor();
    while (peek() && (peek().v === '*' || peek().v === '/')) node = { op: tokens[i++].v, a: node, b: factor() };
    return node;
  }
  function factor() {
    const tok = tokens[i++];
    if (!tok) throw new HttpError(400, `Invalid formula "${text}": unexpected end`);
    if (tok.t === 'num') return { num: tok.v };
    if (tok.t === 'id') return { ref: tok.v };
    if (tok.v === '-') return { op: 'neg', a: factor() };
    if (tok.v === '(') { const n = expr(); expect(')'); return n; }
    throw new HttpError(400, `Invalid formula "${text}": unexpected "${tok.v}"`);
  }
  if (!tokens.length) throw new HttpError(400, 'Formula is empty');
  const ast = expr();
  if (i < tokens.length) throw new HttpError(400, `Invalid formula "${text}": unexpected "${tokens[i].v}"`);
  return ast;
}

export function formulaRefs(ast, out = new Set()) {
  if (ast.ref) out.add(ast.ref);
  if (ast.a) formulaRefs(ast.a, out);
  if (ast.b) formulaRefs(ast.b, out);
  return out;
}

// Row values are integer cents. Numeric constants are treated as plain multipliers
// (e.g. "income * 0.1"); a bare constant in +/- context is interpreted as dollars.
function evalFormula(ast, lookup) {
  if (ast.num !== undefined) return ast.num * 100;
  if (ast.ref) return lookup(ast.ref);
  if (ast.op === 'neg') return -evalFormula(ast.a, lookup);
  const isConst = (n) => n.num !== undefined;
  if (ast.op === '*') {
    if (isConst(ast.a)) return ast.a.num * evalFormula(ast.b, lookup);
    if (isConst(ast.b)) return evalFormula(ast.a, lookup) * ast.b.num;
    return (evalFormula(ast.a, lookup) * evalFormula(ast.b, lookup)) / 100;
  }
  if (ast.op === '/') {
    const b = isConst(ast.b) ? ast.b.num : evalFormula(ast.b, lookup) / 100;
    if (!b) return 0;
    return evalFormula(ast.a, lookup) / b;
  }
  const a = evalFormula(ast.a, lookup);
  const b = evalFormula(ast.b, lookup);
  return ast.op === '+' ? a + b : a - b;
}

// ---------------------------------------------------------------------------
// Definition validation / normalization
// ---------------------------------------------------------------------------
const ROW_KINDS = new Set(['heading', 'accounts', 'net_income', 'formula', 'spacer']);
const DISPLAYS = new Set(['accounts', 'by_type', 'by_group', 'groups', 'total']);
const COLUMN_MODES = new Set(['total', 'fund', 'month', 'quarter', 'year', 'prior_year', 'budget']);

export function normalizeDefinition(def) {
  if (!def || typeof def !== 'object') throw new HttpError(400, 'Report definition is required');
  const type = def.type === 'balance_sheet' ? 'balance_sheet' : 'pnl';
  const columns = def.columns || {};
  const mode = COLUMN_MODES.has(columns.mode) ? columns.mode : 'total';
  const ids = new Set();
  const rows = (Array.isArray(def.rows) ? def.rows : []).map((r, idx) => {
    if (!ROW_KINDS.has(r.kind)) throw new HttpError(400, `Row ${idx + 1}: unknown row type "${r.kind}"`);
    const id = String(r.id || `row${idx + 1}`).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new HttpError(400, `Row ${idx + 1}: id "${id}" must start with a letter and contain only letters, numbers and _`);
    if (ids.has(id)) throw new HttpError(400, `Duplicate row id "${id}"`);
    ids.add(id);
    const row = { ...r, id, label: String(r.label ?? '') };
    if (r.kind === 'accounts') {
      const f = r.filter || {};
      row.filter = {
        categories: (f.categories || []).map(String),
        types: (f.types || []).map(String),
        groups: (f.groups || []).map(Number),
        accounts: (f.accounts || []).map(Number),
      };
      row.display = DISPLAYS.has(r.display) ? r.display : 'accounts';
    }
    if (r.kind === 'formula') row.ast = parseFormula(r.formula);
    if (r.kind === 'net_income') row.scope = ['period', 'current_year', 'prior_years'].includes(r.scope) ? r.scope : 'period';
    return row;
  });
  for (const r of rows) {
    if (r.kind !== 'formula') continue;
    for (const ref of formulaRefs(r.ast)) {
      if (!ids.has(ref)) throw new HttpError(400, `Formula for "${r.label || r.id}" refers to unknown row "${ref}"`);
    }
  }
  return {
    type,
    defaultPeriod: def.defaultPeriod || (type === 'pnl' ? 'this_fiscal_year' : 'today'),
    columns: {
      mode,
      funds: (columns.funds || []).map(Number).filter(Boolean),
      includeNoFund: columns.includeNoFund !== false,
      includeTotal: columns.includeTotal !== false,
      budgetId: Number(columns.budgetId) > 0 ? Number(columns.budgetId) : null,  // budget mode: null = pick automatically
    },
    fundFilter: (def.fundFilter || []).map((f) => (f === NO_FUND ? NO_FUND : String(Number(f)))),
    options: {
      showZeroRows: Boolean(def.options?.showZeroRows),
      showAccountNumbers: def.options?.showAccountNumbers !== false,
      percentOf: def.options?.percentOf || null,
    },
    rows,
  };
}

/** Strip computed fields before saving. */
export function cleanDefinition(def) {
  if (def?.type === 'tuition') return normalizeTuitionDefinition(def);
  if (def?.type === 'trial_balance') return normalizeTrialBalanceDefinition(def);
  if (def?.type === 'bill_aging') return normalizeBillAgingDefinition(def);
  const n = normalizeDefinition(def);
  return { ...n, rows: n.rows.map(({ ast, ...r }) => r) };
}

// ---------------------------------------------------------------------------
// Column construction
// ---------------------------------------------------------------------------
function periodColumns(mode, from, to, fy) {
  const cols = [];
  let start;
  const step = mode === 'month' ? 1 : mode === 'quarter' ? 3 : 12;
  if (mode === 'month') start = monthStart(from);
  else if (mode === 'quarter') start = fiscalQuarterStart(from, fy);
  else start = fiscalYearStart(from, fy);
  while (start <= to) {
    const end = addDays(addMonths(start, step), -1);
    const pFrom = maxDate(start, from);
    const pTo = minDate(end, to);
    let label;
    if (mode === 'month') label = monthLabel(start);
    else if (mode === 'quarter') label = `${monthLabel(start).slice(0, 3)}–${monthLabel(end)}`;
    else label = fy === 1 ? `FY ${parts(start)[0]}` : `FY ${parts(end)[0]}`;
    cols.push({ from: pFrom, to: pTo, label });
    if (cols.length > MAX_COLUMNS) throw new HttpError(400, `Too many columns (max ${MAX_COLUMNS}); choose a shorter date range`);
    start = addMonths(start, step);
  }
  return cols;
}

const shiftYear = (s) => (s ? addMonths(s, -12) : s);

function buildColumns(def, from, to, fy, fundsWithActivity, fundNames, budget) {
  const bs = def.type === 'balance_sheet';
  const cFrom = bs ? null : from;
  const mode = def.columns.mode;
  const base = [];
  const derived = [];
  if (mode === 'fund') {
    const chosen = def.columns.funds.length ? def.columns.funds.map(String) : [...fundsWithActivity].filter((k) => k !== NO_FUND);
    chosen.sort((a, b) => (fundNames[a] || '').localeCompare(fundNames[b] || ''));
    for (const k of chosen) base.push({ from: cFrom, to, funds: new Set([k]), label: fundNames[k] || `Fund ${k}`, fundId: Number(k) });
    if (def.columns.includeNoFund && fundsWithActivity.has(NO_FUND)) base.push({ from: cFrom, to, funds: new Set([NO_FUND]), label: 'No Fund', fundId: NO_FUND });
    if (def.columns.includeTotal || !base.length) {
      const all = def.columns.funds.length ? new Set(base.flatMap((c) => [...c.funds])) : null;
      base.push({ from: cFrom, to, funds: all, label: 'Total', isTotal: true });
    }
  } else if (mode === 'month' || mode === 'quarter' || mode === 'year') {
    const startForPeriods = bs ? (from || fiscalYearStart(to, fy)) : from;
    for (const p of periodColumns(mode, startForPeriods, to, fy)) {
      base.push({ from: bs ? null : p.from, to: p.to, funds: null, label: bs ? `${p.label}` : p.label });
    }
    if (!bs && def.columns.includeTotal && base.length > 1) base.push({ from, to, funds: null, label: 'Total', isTotal: true });
  } else if (mode === 'budget') {
    // A fund budget compares to that fund's actuals; an overall budget to all funds.
    const funds = budget.fund_id ? new Set([String(budget.fund_id)]) : null;
    base.push({ from: cFrom, to, funds, label: 'Actual' });
    base.push({ from: cFrom, to, funds, label: 'Budget', budget: true });
    derived.push({ kind: 'diff', a: 0, b: 1, label: '$ Over / (Under) Budget' });
    derived.push({ kind: 'pct_of', a: 0, b: 1, label: '% of Budget' });
  } else if (mode === 'prior_year') {
    base.push({ from: cFrom, to, funds: null, label: bs ? `As of ${prettyDate(to)}` : 'Current Period' });
    base.push({ from: shiftYear(cFrom), to: shiftYear(to), funds: null, label: bs ? `As of ${prettyDate(shiftYear(to))}` : 'Prior Year' });
    derived.push({ kind: 'diff', a: 0, b: 1, label: '$ Change' });
    derived.push({ kind: 'pct', a: 0, b: 1, label: '% Change' });
  } else {
    base.push({ from: cFrom, to, funds: null, label: 'Total' });
  }
  return { base, derived };
}

// ---------------------------------------------------------------------------
// Report execution
// ---------------------------------------------------------------------------
export async function runReport(db, orgId, rawDef, params = {}) {
  if (rawDef?.type === 'tuition') return runTuitionReport(db, orgId, rawDef, params);
  if (rawDef?.type === 'trial_balance') return runTrialBalance(db, orgId, rawDef, params);
  if (rawDef?.type === 'bill_aging') return runBillAging(db, orgId, rawDef, params);
  const def = normalizeDefinition(rawDef);
  const bs = def.type === 'balance_sheet';
  const to = params.to;
  const from = bs ? (params.from || null) : params.from;
  if (!to || (!bs && !from)) throw new HttpError(400, 'Report date range is required');
  if (from && from > to) throw new HttpError(400, 'Start date must be before end date');

  const [{ rows: orgRows }, { rows: accounts }, { rows: groups }, { rows: funds }] = await Promise.all([
    db.query('SELECT name, fiscal_year_start_month FROM organizations WHERE id = $1', [orgId]),
    db.query('SELECT id, account_number, name, account_type, account_group_id, is_active FROM accounts WHERE organization_id = $1', [orgId]),
    db.query('SELECT id, name, account_type, sort_order FROM account_groups WHERE organization_id = $1 ORDER BY sort_order, name', [orgId]),
    db.query('SELECT id, name FROM funds WHERE organization_id = $1', [orgId]),
  ]);
  const fy = orgRows[0]?.fiscal_year_start_month || 1;
  const fundNames = Object.fromEntries(funds.map((f) => [String(f.id), f.name]));
  const fundFilter = def.fundFilter.length ? new Set(def.fundFilter) : null;

  // Latest date any column may need (prior-year columns only need earlier data).
  const { rows: agg } = await db.query(
    `SELECT d.account_id, d.fund_id, h.date,
            SUM(ROUND(d.debit * 100))::bigint AS dr, SUM(ROUND(d.credit * 100))::bigint AS cr
       FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id
      WHERE h.organization_id = $1 AND h.date <= $2
      GROUP BY d.account_id, d.fund_id, h.date`,
    [orgId, to],
  );
  const acctById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const facts = [];
  const fundsWithActivity = new Set();
  for (const r of agg) {
    const fk = fundKey(r.fund_id);
    if (fundFilter && !fundFilter.has(fk)) continue;
    const acct = acctById[r.account_id];
    if (!acct) continue;
    const net = Number(r.dr) - Number(r.cr);
    if (net === 0) continue;
    facts.push({ accountId: r.account_id, fk, date: r.date, net, category: TYPE_BY_KEY[acct.account_type]?.category });
    // Fund columns: show funds with activity in the report window (cumulative for balance sheets).
    if (!from || r.date >= from) fundsWithActivity.add(fk);
  }

  let budget = null;
  if (def.columns.mode === 'budget') {
    const budgetId = Number(params.budgetId) || def.columns.budgetId || await defaultBudgetId(db, orgId, to);
    if (!budgetId) throw new HttpError(400, 'There are no budgets yet. Create one under Budgets to compare it to actuals.');
    budget = await loadBudget(db, orgId, budgetId);
  }
  const { base, derived } = buildColumns(def, from, to, fy, fundsWithActivity, fundNames, budget);
  const inCol = (f, col, start = col.from, end = col.to) =>
    (!start || f.date >= start) && f.date <= end && (!col.funds || col.funds.has(f.fk));
  const rawOf = (acct, normalAmount) => (TYPE_BY_KEY[acct.account_type]?.normal === 'credit' ? -normalAmount : normalAmount);
  // Budget column of a balance sheet: actual balances up to the budget's start, then the budgeted changes.
  const beforeBudget = budget ? addDays(budget.start_date, -1) : null;
  const budgetCol = (col, start, end) => {
    const amounts = budgetAmounts(budget, budget.lines, start, end);
    return { amounts, actualEnd: bs ? minDate(end, beforeBudget) : null };
  };

  // Raw (debit - credit) per account per base column.
  const acctCol = base.map(() => new Map());
  const budgetParts = base.map((col) => (col.budget ? budgetCol(col, col.from, col.to) : null));
  for (const f of facts) {
    base.forEach((col, ci) => {
      const end = col.budget ? budgetParts[ci].actualEnd : col.to;
      if (end && inCol(f, col, col.from, end)) acctCol[ci].set(f.accountId, (acctCol[ci].get(f.accountId) || 0) + f.net);
    });
  }
  budgetParts.forEach((part, ci) => {
    if (!part) return;
    for (const [accountId, amt] of part.amounts) {
      const acct = acctById[accountId];
      if (acct) acctCol[ci].set(accountId, (acctCol[ci].get(accountId) || 0) + rawOf(acct, amt));
    }
  });
  const signed = rawOf;
  const acctValues = (acct) => base.map((_, ci) => signed(acct, acctCol[ci].get(acct.id) || 0));

  function netIncome(scope) {
    return base.map((col) => {
      let start = col.from;
      let end = col.to;
      if (scope === 'current_year') start = fiscalYearStart(col.to, fy);
      if (scope === 'prior_years') { start = null; end = addDays(fiscalYearStart(col.to, fy), -1); }
      let total = 0;
      const isPnl = (category) => category === 'income' || category === 'expense';
      const part = col.budget ? budgetCol(col, start, end) : null;
      const actualEnd = part ? part.actualEnd : end;
      if (actualEnd) {
        for (const f of facts) {
          if (isPnl(f.category) && inCol(f, col, start, actualEnd)) total -= f.net;
        }
      }
      if (part) {
        for (const [accountId, amt] of part.amounts) {
          const acct = acctById[accountId];
          if (acct && isPnl(TYPE_BY_KEY[acct.account_type]?.category)) total -= rawOf(acct, amt);
        }
      }
      return total;
    });
  }

  const matches = (acct, filter) =>
    (!filter.categories.length || filter.categories.includes(TYPE_BY_KEY[acct.account_type]?.category)) &&
    (!filter.types.length || filter.types.includes(acct.account_type)) &&
    (!filter.groups.length || filter.groups.includes(acct.account_group_id)) &&
    (!filter.accounts.length || filter.accounts.includes(acct.id));

  const acctLabel = (a) => (def.options.showAccountNumbers && a.account_number ? `${a.account_number} · ${a.name}` : a.name);
  const sortAccts = (list) => list.sort((a, b) => (a.account_number || '').localeCompare(b.account_number || '', undefined, { numeric: true }) || a.name.localeCompare(b.name));
  const zeros = () => base.map(() => 0);
  const sum = (lists) => lists.reduce((acc, v) => acc.map((x, i) => x + v[i]), zeros());
  const isZero = (vals) => vals.every((v) => Math.abs(v) < 0.5);

  // Pass 1: compute totals of non-formula rows; build their display lines.
  const rowTotals = {};
  const rowLines = {};
  for (const row of def.rows) {
    const lines = [];
    if (row.kind === 'accounts') {
      const negate = row.negate ? -1 : 1;
      const list = sortAccts(accounts.filter((a) => matches(a, row.filter))).map((a) => ({ acct: a, values: acctValues(a).map((v) => v * negate) }));
      const visible = list.filter((x) => def.options.showZeroRows ? x.acct.is_active || !isZero(x.values) : !isZero(x.values));
      const total = sum(list.map((x) => x.values));
      rowTotals[row.id] = total;
      // Skip sections with nothing to show (e.g. no liability accounts with balances).
      if (!visible.length && isZero(total) && !def.options.showZeroRows) { rowLines[row.id] = []; continue; }
      if (row.showHeader && row.display !== 'total') lines.push({ type: 'header', label: row.label, level: 0 });
      const lvl = row.showHeader ? 1 : 0;
      const acctLine = (x, level) => ({ type: 'account', label: acctLabel(x.acct), level, values: x.values, accountIds: [x.acct.id] });
      const subsection = (label, items) => {
        if (!items.length) return;
        lines.push({ type: 'subheader', label, level: lvl });
        items.forEach((x) => lines.push(acctLine(x, lvl + 1)));
        lines.push({ type: 'subtotal', label: `Total ${label}`, level: lvl, values: sum(items.map((x) => x.values)), accountIds: items.map((x) => x.acct.id) });
      };
      if (row.display === 'accounts') visible.forEach((x) => lines.push(acctLine(x, lvl)));
      else if (row.display === 'by_type') {
        for (const t of ACCOUNT_TYPES) subsection(t.label, visible.filter((x) => x.acct.account_type === t.key));
      } else if (row.display === 'by_group' || row.display === 'groups') {
        const buckets = [...groups.map((g) => ({ label: g.name, id: g.id })), { label: 'Other', id: null }];
        for (const g of buckets) {
          const items = visible.filter((x) => (x.acct.account_group_id || null) === g.id || (g.id === null && !groups.some((gg) => gg.id === x.acct.account_group_id)));
          if (!items.length) continue;
          if (row.display === 'by_group') subsection(g.label, items);
          else lines.push({ type: 'account', label: g.label, level: lvl, values: sum(items.map((x) => x.values)), accountIds: items.map((x) => x.acct.id) });
        }
      }
      const allIds = list.map((x) => x.acct.id);
      if (row.display === 'total') lines.push({ type: 'total', label: row.label, level: 0, values: total, accountIds: allIds });
      else if (row.showTotal) lines.push({ type: 'total', label: row.totalLabel || `Total ${row.label}`, level: 0, values: total, accountIds: allIds });
    } else if (row.kind === 'net_income') {
      const values = netIncome(row.scope);
      rowTotals[row.id] = values;
      if (def.options.showZeroRows || !isZero(values)) lines.push({ type: 'line', label: row.label, level: 1, values });
    } else if (row.kind === 'heading') {
      lines.push({ type: 'heading', label: row.label, level: 0 });
    } else if (row.kind === 'spacer') {
      lines.push({ type: 'spacer' });
    }
    rowLines[row.id] = lines;
  }

  // Pass 2: formulas (may reference any row, including later formulas).
  const byId = Object.fromEntries(def.rows.map((r) => [r.id, r]));
  const visiting = new Set();
  function totalOf(id) {
    if (rowTotals[id]) return rowTotals[id];
    const row = byId[id];
    if (!row || row.kind !== 'formula') return zeros();
    if (visiting.has(id)) throw new HttpError(400, `Formula for "${row.label || id}" refers to itself`);
    visiting.add(id);
    const values = base.map((_, ci) => Math.round(evalFormula(row.ast, (ref) => totalOf(ref)[ci])));
    visiting.delete(id);
    rowTotals[id] = values;
    return values;
  }
  for (const row of def.rows) {
    if (row.kind !== 'formula') continue;
    const values = totalOf(row.id);
    rowLines[row.id] = row.hideIfZero && isZero(values) ? [] : [{ type: 'formula', label: row.label, level: 0, values, style: row.style || 'bold' }];
  }

  // Assemble output, adding derived columns and percentages.
  const percentBase = def.options.percentOf && rowTotals[def.options.percentOf] ? rowTotals[def.options.percentOf] : null;
  const lines = [];
  for (const row of def.rows) {
    for (const line of rowLines[row.id]) {
      if (line.values) {
        const vals = line.values;
        line.values = [...vals, ...derived.map((d) => {
          if (d.kind === 'diff') return vals[d.a] - vals[d.b];
          if (!vals[d.b]) return null;
          return d.kind === 'pct_of' ? (vals[d.a] / vals[d.b]) * 100 : ((vals[d.a] - vals[d.b]) / Math.abs(vals[d.b])) * 100;
        })];
        if (percentBase) line.percents = vals.map((v, i) => (percentBase[i] ? (v / percentBase[i]) * 100 : null));
      }
      lines.push(line);
    }
  }

  const columns = [
    ...base.map((c, i) => ({ key: `c${i}`, label: c.label, from: c.from, to: c.to, fundId: c.fundId ?? null, funds: c.funds ? [...c.funds] : null, isTotal: Boolean(c.isTotal), kind: 'amount', budget: Boolean(c.budget) })),
    ...derived.map((d, i) => ({ key: `d${i}`, label: d.label, kind: d.kind === 'diff' ? 'amount' : 'percent', derived: true })),
  ];
  return {
    organization: orgRows[0]?.name,
    type: def.type,
    from,
    to,
    subtitle: bs ? `As of ${prettyDate(to)}` : `${prettyDate(from)} – ${prettyDate(to)}`,
    budget: budget && {
      id: budget.id, name: budget.name, start_date: budget.start_date, end_date: budget.end_date,
      fund_id: budget.fund_id, fund_name: budget.fund_name,
    },
    fundFilter: fundFilter ? [...fundFilter].map((k) => (k === NO_FUND ? 'No Fund' : fundNames[k] || k)) : null,
    hasPercent: Boolean(percentBase),
    columns,
    lines,
  };
}

/** GL lines behind a report cell. */
export async function drilldown(db, orgId, { accountIds = [], from = null, to, funds = null, fundFilter = [] }) {
  if (!to) throw new HttpError(400, 'Date is required');
  const ids = accountIds.map(Number).filter(Boolean);
  if (!ids.length) return [];
  const params = [orgId, ids, to];
  let where = 'h.organization_id = $1 AND d.account_id = ANY($2::int[]) AND h.date <= $3';
  if (from) { params.push(from); where += ` AND h.date >= $${params.length}`; }
  const fundClause = (list) => {
    const realIds = list.filter((k) => k !== NO_FUND).map(Number);
    const parts = [];
    if (realIds.length) { params.push(realIds); parts.push(`d.fund_id = ANY($${params.length}::int[])`); }
    if (list.includes(NO_FUND)) parts.push('d.fund_id IS NULL');
    return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
  };
  if (funds) where += ` AND ${fundClause(funds.map(String))}`;
  if (fundFilter && fundFilter.length) where += ` AND ${fundClause(fundFilter.map(String))}`;
  const { rows } = await db.query(
    `SELECT h.date, h.transaction_id, h.entry_kind, h.description, t.transaction_type, t.check_number, t.ref_number,
            c.name AS company_name, a.account_number, a.name AS account_name, a.account_type, f.name AS fund_name,
            d.debit, d.credit, COALESCE(td.memo, t.memo) AS memo
       FROM gl_details d
       JOIN gl_headers h ON h.id = d.gl_header_id
       JOIN accounts a ON a.id = d.account_id
       LEFT JOIN funds f ON f.id = d.fund_id
       LEFT JOIN transactions t ON t.id = h.transaction_id
       LEFT JOIN companies c ON c.id = t.company_id
       LEFT JOIN transaction_details td ON td.id = d.transaction_detail_id
      WHERE ${where}
      ORDER BY h.date, h.id, d.id
      LIMIT 2000`,
    params,
  );
  return rows;
}
