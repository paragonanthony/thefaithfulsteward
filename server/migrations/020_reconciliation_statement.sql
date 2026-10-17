-- A statement read by Claude on the reconciliation screen: its lines and summary, kept so the matching can be
-- re-run after missing transactions are created.
ALTER TABLE reconciliations ADD COLUMN statement_extract JSONB;
