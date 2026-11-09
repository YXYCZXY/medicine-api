-- No implicit deletion or identity guessing. Explicitly clean disposable data separately.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'Supabase cutover requires an empty users table; clean disposable test data separately';
  END IF;
END $$;
DROP TABLE user_sessions;
ALTER TABLE users DROP COLUMN account, DROP COLUMN password_hash;
ALTER TABLE users ALTER COLUMN id DROP DEFAULT;
ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
CREATE UNIQUE INDEX users_phone_key ON users(phone);
ALTER TABLE users ADD CONSTRAINT users_phone_e164_check CHECK (phone ~ '^\+861[3-9][0-9]{9}$');
