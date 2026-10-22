CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE deployment_settings (id integer PRIMARY KEY CHECK(id=1), route_fingerprint text NOT NULL, credential_fingerprint text NOT NULL);
CREATE TABLE receiving_addresses (address text PRIMARY KEY, reserved_invoice_id uuid UNIQUE);
CREATE TABLE invoices (
  id uuid PRIMARY KEY, external_order_id text UNIQUE NOT NULL, idempotency_key text UNIQUE NOT NULL,
  request_hash text NOT NULL, route_id text NOT NULL, amount_units numeric(78,0) NOT NULL CHECK(amount_units > 0),
  recipient text UNIQUE NOT NULL REFERENCES receiving_addresses(address),
  status text NOT NULL CHECK(status IN ('pending','expired','paid','needs_review')),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, monitor_until timestamptz NOT NULL,
  last_scanned_block bigint NOT NULL, last_scanned_hash text, last_checked_at timestamptz NOT NULL DEFAULT 'epoch',
  monitoring_complete boolean NOT NULL DEFAULT false, voucher_spec jsonb, paid_at timestamptz,
  CHECK(expires_at > created_at), CHECK(monitor_until > expires_at)
);
CREATE INDEX invoices_monitor ON invoices (last_checked_at) WHERE NOT monitoring_complete;
CREATE TABLE transfers (
  route_id text NOT NULL, transaction_hash text NOT NULL, log_index integer NOT NULL CHECK(log_index >= 0),
  invoice_id uuid NOT NULL REFERENCES invoices(id), token text NOT NULL, recipient text NOT NULL,
  sender text NOT NULL, amount_units numeric(78,0) NOT NULL, block_number bigint NOT NULL,
  block_hash text NOT NULL, block_time timestamptz NOT NULL, disposition text NOT NULL,
  PRIMARY KEY(route_id, transaction_hash, log_index)
);
CREATE INDEX transfers_invoice ON transfers(invoice_id, block_number, log_index);
CREATE UNIQUE INDEX one_accepted_transfer ON transfers(invoice_id) WHERE disposition='accepted';
CREATE TABLE vouchers (
  id uuid PRIMARY KEY, invoice_id uuid UNIQUE NOT NULL REFERENCES invoices(id), code_hash text UNIQUE NOT NULL,
  entitlement jsonb NOT NULL, expires_at timestamptz NOT NULL, redeemed_at timestamptz, redeemed_by text, redemption_key text,
  CHECK((redeemed_at IS NULL) = (redeemed_by IS NULL))
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES invoices(id), event_type text NOT NULL, body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_owner uuid,
  delivered_at timestamptz, dead_at timestamptz, last_error text
);
CREATE INDEX outbox_pending ON outbox(next_attempt_at) WHERE delivered_at IS NULL AND dead_at IS NULL;
INSERT INTO schema_migrations(version) VALUES (1);
