-- Separate merchant database. These are example order records, not the core's payment ledger.
CREATE TABLE IF NOT EXISTS merchant_events (id uuid PRIMARY KEY, body_hash text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS merchant_entitlements (invoice_id uuid PRIMARY KEY, active boolean NOT NULL, granted_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS merchant_refund_holds (invoice_id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
