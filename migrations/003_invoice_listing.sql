CREATE INDEX invoices_created ON invoices(created_at DESC,id DESC);
CREATE INDEX invoices_status_created ON invoices(status,created_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES (3);
