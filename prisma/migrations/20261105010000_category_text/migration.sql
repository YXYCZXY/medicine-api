-- 仅支持空药箱升级；不转换历史分类，也不自动删除业务数据。
BEGIN;

ALTER TABLE medicine_items ADD COLUMN category VARCHAR(50) NOT NULL;
ALTER TABLE medicine_items DROP CONSTRAINT fk_medicine_items_category;
DROP INDEX idx_medicine_items_user_category;
ALTER TABLE medicine_items DROP COLUMN category_id;
DROP TABLE medicine_categories;

CREATE INDEX idx_medicine_items_user_category ON medicine_items(user_id, category);
COMMENT ON COLUMN medicine_items.category IS '药品大类，保存单个非空文本标签';
COMMENT ON INDEX idx_medicine_items_user_category IS '用户 + 分类联合查询';

COMMIT;
