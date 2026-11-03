ALTER TABLE medicine_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE medicine_items ADD CONSTRAINT medicine_version_positive CHECK (version > 0);
CREATE FUNCTION bump_medicine_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$;
CREATE TRIGGER medicine_version BEFORE UPDATE ON medicine_items FOR EACH ROW EXECUTE FUNCTION bump_medicine_version();

CREATE TABLE sync_command_receipts (
 user_id UUID NOT NULL, op_id UUID NOT NULL, device_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 entity_id UUID NOT NULL, type TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
 result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id, op_id), CHECK(sequence > 0), CHECK(status IN ('accepted','rejected'))
);
CREATE UNIQUE INDEX sync_receipt_device ON sync_command_receipts(user_id,device_id,sequence);
CREATE TABLE sync_tombstones (
 user_id UUID NOT NULL, kind TEXT NOT NULL, entity_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,kind,entity_id)
);
CREATE TABLE sync_reminder_revisions (
 user_id UUID NOT NULL, reminder_id UUID NOT NULL, version INTEGER NOT NULL, record JSONB NOT NULL,
 PRIMARY KEY(user_id,reminder_id,version)
);
CREATE TABLE sync_attachments (
 user_id UUID NOT NULL, id UUID NOT NULL, digest TEXT NOT NULL, content BYTEA NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,id),
 CHECK(octet_length(content) > 0 AND octet_length(content) <= 8388608)
);
CREATE FUNCTION remember_sync_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO sync_tombstones(user_id,kind,entity_id) VALUES(OLD.user_id,TG_ARGV[0],OLD.id) ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER sync_delete_medicine AFTER DELETE ON medicine_items FOR EACH ROW EXECUTE FUNCTION remember_sync_delete('medicine');
CREATE TRIGGER sync_delete_visit AFTER DELETE ON visit_records FOR EACH ROW EXECUTE FUNCTION remember_sync_delete('visit');
CREATE TRIGGER sync_delete_reminder AFTER DELETE ON health_reminders FOR EACH ROW EXECUTE FUNCTION remember_sync_delete('reminder');

-- Stable offline directory. Existing category IDs and references are retained.
-- Offline IDs are resolved to an existing same-name directory entry at the sync boundary.
INSERT INTO medicine_categories(id,name,sort_order) VALUES
 ('31000000-0000-4000-8000-000000000001','感冒发烧',10),
 ('31000000-0000-4000-8000-000000000002','止痛',20),
 ('31000000-0000-4000-8000-000000000003','肠胃',30),
 ('31000000-0000-4000-8000-000000000004','过敏',40),
 ('31000000-0000-4000-8000-000000000005','外伤',50),
 ('31000000-0000-4000-8000-000000000006','抗感染',60),
 ('31000000-0000-4000-8000-000000000007','慢性病',70),
 ('31000000-0000-4000-8000-000000000008','其他',999)
ON CONFLICT(name) DO NOTHING;
