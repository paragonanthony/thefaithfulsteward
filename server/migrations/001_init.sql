-- Core schema for the non-profit accounting system.
-- Every tenant-owned table carries organization_id; all queries are scoped by it.

CREATE TABLE organizations (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  address1 TEXT, address2 TEXT, city TEXT, state TEXT, postal TEXT, phone TEXT, email TEXT, ein TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  email           TEXT,
  is_system_admin BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

CREATE TABLE user_organizations (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE funds (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  is_restricted   BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX funds_org_idx ON funds (organization_id);

-- Account types are fixed (see server/accountTypes.js)
CREATE TABLE account_groups (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  account_type    TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX account_groups_org_idx ON account_groups (organization_id);

CREATE TABLE accounts (
  id                      SERIAL PRIMARY KEY,
  organization_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_number          TEXT,
  name                    TEXT NOT NULL,
  account_type            TEXT NOT NULL,
  description             TEXT,
  account_group_id        INTEGER REFERENCES account_groups(id) ON DELETE SET NULL,
  default_fund_id         INTEGER REFERENCES funds(id) ON DELETE SET NULL,
  is_undeposited_funds    BOOLEAN NOT NULL DEFAULT false,
  is_active               BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX accounts_org_idx ON accounts (organization_id);

-- Customers, Donors and Vendors
CREATE TABLE companies (
  id                          SERIAL PRIMARY KEY,
  organization_id             INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  address1 TEXT, address2 TEXT, city TEXT, state TEXT, postal TEXT,
  phone1 TEXT, phone2 TEXT, email TEXT, notes TEXT,
  default_income_account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  default_expense_account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  is_active                   BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX companies_org_idx ON companies (organization_id);

-- Income, Expense, Deposit and Reconciliation transactions
CREATE TABLE transactions (
  id                  SERIAL PRIMARY KEY,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_type    TEXT NOT NULL CHECK (transaction_type IN ('income', 'expense', 'deposit', 'reconciliation')),
  transaction_method  TEXT CHECK (transaction_method IN ('electronic', 'check')),
  date                DATE NOT NULL,
  amount              NUMERIC(14,2) NOT NULL DEFAULT 0,
  ref_number          TEXT,
  check_number        TEXT,
  account_id          INTEGER REFERENCES accounts(id),
  fund_id             INTEGER REFERENCES funds(id),
  company_id          INTEGER REFERENCES companies(id),
  memo                TEXT,
  created_by_user_id  INTEGER REFERENCES users(id),
  reconciliation_id   INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_org_type_date_idx ON transactions (organization_id, transaction_type, date);
CREATE INDEX transactions_account_idx ON transactions (account_id);
CREATE INDEX transactions_rec_idx ON transactions (reconciliation_id);

CREATE TABLE transaction_details (
  id                     SERIAL PRIMARY KEY,
  transaction_id         INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id             INTEGER REFERENCES accounts(id),
  amount                 NUMERIC(14,2) NOT NULL,
  memo                   TEXT,
  fund_id                INTEGER REFERENCES funds(id),
  linked_transaction_id  INTEGER REFERENCES transactions(id),
  sort_order             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX transaction_details_txn_idx ON transaction_details (transaction_id);
CREATE INDEX transaction_details_linked_idx ON transaction_details (linked_transaction_id);

-- Reconciliation-specific fields (1:1 with a transaction of type 'reconciliation')
CREATE TABLE reconciliations (
  transaction_id              INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  statement_date              DATE NOT NULL,
  beginning_balance           NUMERIC(14,2) NOT NULL DEFAULT 0,
  statement_ending_balance    NUMERIC(14,2) NOT NULL DEFAULT 0,
  service_charge_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  service_charge_date         DATE,
  service_charge_account_id   INTEGER REFERENCES accounts(id),
  service_charge_fund_id      INTEGER REFERENCES funds(id),
  interest_amount             NUMERIC(14,2) NOT NULL DEFAULT 0,
  interest_date               DATE,
  interest_account_id         INTEGER REFERENCES accounts(id),
  interest_fund_id            INTEGER REFERENCES funds(id),
  is_complete                 BOOLEAN NOT NULL DEFAULT false,
  completed_at                TIMESTAMPTZ
);

-- General ledger
CREATE TABLE gl_headers (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  transaction_id   INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  entry_kind       TEXT NOT NULL DEFAULT 'transaction',   -- transaction | service_charge | interest
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gl_headers_org_date_idx ON gl_headers (organization_id, date);
CREATE INDEX gl_headers_txn_idx ON gl_headers (transaction_id);

CREATE TABLE gl_details (
  id                     SERIAL PRIMARY KEY,
  gl_header_id           INTEGER NOT NULL REFERENCES gl_headers(id) ON DELETE CASCADE,
  account_id             INTEGER NOT NULL REFERENCES accounts(id),
  fund_id                INTEGER REFERENCES funds(id),
  debit                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  transaction_detail_id  INTEGER REFERENCES transaction_details(id) ON DELETE SET NULL
);
CREATE INDEX gl_details_header_idx ON gl_details (gl_header_id);
CREATE INDEX gl_details_account_idx ON gl_details (account_id);

-- Bank feed lines imported from a bank statement file
CREATE TABLE bank_feed_items (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  description      TEXT,
  amount           NUMERIC(14,2) NOT NULL,   -- positive = money in, negative = money out
  external_id      TEXT,
  status           TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'ignored')),
  transaction_id   INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  imported_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bank_feed_items_org_acct_idx ON bank_feed_items (organization_id, account_id, status);

-- Report definitions (built-in reports are seeded per organization and can be customized)
CREATE TABLE report_definitions (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  builtin_key      TEXT,        -- set for the seeded standard reports (allows "reset to default")
  definition       JSONB NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX report_definitions_org_idx ON report_definitions (organization_id);

-- Session store used by connect-pg-simple
CREATE TABLE "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
