ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled', 'deleting'));
CREATE TABLE account_deletion_challenges (
  user_id UUID PRIMARY KEY,
  next_send_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE account_deletion_tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  stage VARCHAR(16) NOT NULL DEFAULT 'business',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_deletion_tasks_next_attempt_at_idx ON account_deletion_tasks(next_attempt_at);
CREATE TABLE account_deletion_receipts (
  id UUID PRIMARY KEY,
  secret_hash VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  expires_at TIMESTAMPTZ
);
