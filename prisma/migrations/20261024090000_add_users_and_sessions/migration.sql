CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account VARCHAR(64) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname VARCHAR(50) NOT NULL,
    phone VARCHAR(20),
    phone_verified_at TIMESTAMPTZ,
    avatar_url TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ,
    CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
    CONSTRAINT users_account_normalized_check CHECK (account = lower(account))
);

CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX user_sessions_user_id_expires_at_idx ON user_sessions(user_id, expires_at);

-- Preserve every existing owner ID. These accounts cannot log in until explicitly activated.
INSERT INTO users (id, account, password_hash, nickname, status)
SELECT owner_id, 'legacy-' || owner_id::text, '!legacy!', '原有用户', 'disabled'
FROM (
    SELECT user_id AS owner_id FROM medicine_items
    UNION SELECT user_id FROM visit_records
    UNION SELECT user_id FROM health_reminders
    UNION SELECT user_id FROM blood_pressure_records
) owners;

ALTER TABLE medicine_items ADD CONSTRAINT fk_medicine_items_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE visit_records ADD CONSTRAINT fk_visit_records_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE health_reminders ADD CONSTRAINT fk_health_reminders_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE blood_pressure_records ADD CONSTRAINT fk_blood_pressure_records_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
