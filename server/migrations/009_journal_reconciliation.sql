-- Journal entry lines to bank / credit card accounts are cleared per line (one entry can touch several bank accounts).
ALTER TABLE transaction_details ADD COLUMN reconciliation_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;
CREATE INDEX transaction_details_rec_idx ON transaction_details (reconciliation_id);
