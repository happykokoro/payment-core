ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK(status IN ('pending','expired','paid','needs_review','cancelled'));
ALTER TABLE invoices ADD COLUMN cancelled_at timestamptz;
-- Review belongs to individual transfers; legacy review invoices can accept correct evidence again.
UPDATE invoices SET status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'pending' END WHERE status='needs_review';
CREATE TABLE credential_keys (fingerprint text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
INSERT INTO credential_keys(fingerprint) SELECT credential_fingerprint FROM deployment_settings;
ALTER TABLE vouchers ADD COLUMN key_fingerprint text REFERENCES credential_keys(fingerprint);
UPDATE vouchers SET key_fingerprint=(SELECT credential_fingerprint FROM deployment_settings);
ALTER TABLE vouchers ALTER COLUMN key_fingerprint SET NOT NULL;
ALTER TABLE vouchers ADD COLUMN generation integer NOT NULL DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN frozen_at timestamptz;
ALTER TABLE vouchers ADD COLUMN revoked_at timestamptz;
CREATE TABLE operations (
  idempotency_key text PRIMARY KEY, kind text NOT NULL, request_hash text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
  id uuid PRIMARY KEY, invoice_id uuid REFERENCES invoices(id), action text NOT NULL,
  actor text NOT NULL, reason text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_invoice ON audit_log(invoice_id,created_at);
CREATE TABLE transfer_reviews (
  route_id text NOT NULL, transaction_hash text NOT NULL, log_index integer NOT NULL,
  resolution text NOT NULL CHECK(resolution IN ('acknowledged','refund_required')),
  actor text NOT NULL, reason text NOT NULL, resolved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(route_id,transaction_hash,log_index),
  FOREIGN KEY(route_id,transaction_hash,log_index) REFERENCES transfers(route_id,transaction_hash,log_index)
);
CREATE TABLE refunds (
  id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES invoices(id), route_id text NOT NULL,
  source_transaction_hash text NOT NULL, source_log_index integer NOT NULL,
  amount_units numeric(78,0) NOT NULL CHECK(amount_units>0), recipient text NOT NULL,
  status text NOT NULL CHECK(status IN ('prepared','recorded','cancelled')),
  prepared_at timestamptz NOT NULL DEFAULT date_trunc('second',clock_timestamp()),
  recorded_at timestamptz, cancelled_at timestamptz, transaction_hash text, log_index integer, proof jsonb,
  FOREIGN KEY(route_id,source_transaction_hash,source_log_index) REFERENCES transfers(route_id,transaction_hash,log_index),
  UNIQUE(route_id,transaction_hash,log_index)
);
CREATE INDEX refunds_invoice ON refunds(invoice_id);
CREATE TABLE observation_cursors (
  invoice_id uuid PRIMARY KEY REFERENCES invoices(id), block_number bigint NOT NULL, block_hash text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_observations (
  invoice_id uuid NOT NULL REFERENCES invoices(id), transaction_hash text NOT NULL, log_index integer NOT NULL,
  block_number bigint NOT NULL, block_hash text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(invoice_id,transaction_hash,log_index)
);
INSERT INTO schema_migrations(version) VALUES(2);
