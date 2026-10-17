-- Fund Balances report: show each fund's balance by balance sheet account (assets less liabilities) instead of by
-- net assets account. Only reports still using the original rows are changed; column and fund choices are kept.
UPDATE report_definitions
   SET definition = jsonb_set(definition, '{rows}', '[{"id": "assets", "kind": "accounts", "label": "Assets", "filter": {"categories": ["asset"]}, "display": "accounts", "showHeader": true, "showTotal": true, "totalLabel": "Total Assets"}, {"id": "liabilities", "kind": "accounts", "label": "Liabilities", "filter": {"categories": ["liability"]}, "display": "accounts", "showHeader": true, "showTotal": true, "totalLabel": "Total Liabilities"}, {"id": "fund_balance", "kind": "formula", "label": "Fund Balance", "formula": "assets - liabilities", "style": "grand"}]'::jsonb),
       description = 'Each fund’s balance as of a date, by balance sheet account: what the fund holds in each asset account, less what it owes on each liability account.'
 WHERE builtin_key = 'fund_balances'
   AND jsonb_path_query_array(definition, '$.rows[*].id') = '["equity", "prior_ni", "current_ni", "fund_balance"]'::jsonb
   AND jsonb_path_query_array(definition, '$.rows[*].label') = '["Net Assets Accounts", "Accumulated Change in Net Assets (Prior Years)", "Change in Net Assets (Current Year)", "Fund Balance"]'::jsonb
   AND definition #>> '{rows,3,formula}' = 'equity + prior_ni + current_ni';
