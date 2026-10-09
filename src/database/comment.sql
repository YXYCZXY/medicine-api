-- =========================================================
-- 千方记 - 小药箱 V1 数据库注释
-- PostgreSQL
-- 需在 init.sql 执行之后执行，可重复执行
-- =========================================================


-- ---------------------------------------------------------
-- 1. 枚举类型
-- ---------------------------------------------------------

COMMENT ON TYPE medicine_unit IS '药品数量单位：GRAIN-粒，BAG-袋，BOTTLE-瓶';
COMMENT ON TYPE medication_timing IS '服药时机：BEFORE_MEAL-饭前，AFTER_MEAL-饭后，WITH_MEAL-随餐，ON_WAKING-早起空腹，BEFORE_SLEEP-睡前，ANY_TIME-不限时间';


-- ---------------------------------------------------------
-- 2. 药品分类表
-- ---------------------------------------------------------

COMMENT ON TABLE medicine_categories IS '药品分类表';

COMMENT ON COLUMN medicine_categories.id IS '主键 ID';
COMMENT ON COLUMN medicine_categories.name IS '分类名称，唯一';
COMMENT ON COLUMN medicine_categories.sort_order IS '排序，数字越小越靠前';
COMMENT ON COLUMN medicine_categories.created_at IS '创建时间';
COMMENT ON COLUMN medicine_categories.updated_at IS '更新时间';


-- ---------------------------------------------------------
-- 3. 药箱主表
-- ---------------------------------------------------------

COMMENT ON TABLE medicine_items IS '药箱主表，记录用户药箱中的药品';

COMMENT ON COLUMN medicine_items.id IS '主键 ID';
COMMENT ON COLUMN medicine_items.user_id IS '所属用户 ID（用户系统未建立，暂无外键）';
COMMENT ON COLUMN medicine_items.name IS '药品名称（同一种药可能存在多盒/多批次，不唯一）';
COMMENT ON COLUMN medicine_items.specification IS '规格，例如：0.25g × 24粒';
COMMENT ON COLUMN medicine_items.dosage_form IS '剂型，例如：胶囊、颗粒剂、糖浆';
COMMENT ON COLUMN medicine_items.quantity IS '当前剩余数量，不能小于 0';
COMMENT ON COLUMN medicine_items.unit IS '单位：GRAIN-粒，BAG-袋，BOTTLE-瓶';
COMMENT ON COLUMN medicine_items.expiration_date IS '有效期';
COMMENT ON COLUMN medicine_items.manufacturer IS '生产厂家';
COMMENT ON COLUMN medicine_items.efficacy IS '功效 / 作用';
COMMENT ON COLUMN medicine_items.dose_per_time IS '每次用量，单位同 unit，例如 0.5 表示半粒';
COMMENT ON COLUMN medicine_items.times_per_day IS '每天服用次数';
COMMENT ON COLUMN medicine_items.medication_timing IS '服药时机';
COMMENT ON COLUMN medicine_items.location IS '存放位置';
COMMENT ON COLUMN medicine_items.image_url IS '药品主图 URL';
COMMENT ON COLUMN medicine_items.note IS '用户备注';
COMMENT ON COLUMN medicine_items.created_at IS '创建时间';
COMMENT ON COLUMN medicine_items.updated_at IS '更新时间';

COMMENT ON CONSTRAINT medicine_items_quantity_check ON medicine_items IS '库存不能小于 0';
COMMENT ON CONSTRAINT medicine_items_dose_per_time_check ON medicine_items IS '每次用量必须大于 0';
COMMENT ON CONSTRAINT medicine_items_times_per_day_check ON medicine_items IS '每天次数必须大于 0';


-- ---------------------------------------------------------
-- 4. 药品与分类关联表
-- ---------------------------------------------------------

COMMENT ON TABLE medicine_category_relations IS '药品与分类关联表，一个药品可以属于多个分类';

COMMENT ON COLUMN medicine_category_relations.medicine_item_id IS '药品 ID，关联 medicine_items.id';
COMMENT ON COLUMN medicine_category_relations.category_id IS '分类 ID，关联 medicine_categories.id';
COMMENT ON COLUMN medicine_category_relations.created_at IS '创建时间';


-- ---------------------------------------------------------
-- 5. 索引
-- ---------------------------------------------------------

COMMENT ON INDEX idx_medicine_items_user_id IS '查询某个用户的药品';
COMMENT ON INDEX idx_medicine_items_name IS '按药品名称查询';
COMMENT ON INDEX idx_medicine_items_expiration_date IS '查询即将过期 / 已过期药品';
COMMENT ON INDEX idx_medicine_items_user_name IS '用户 + 药品名称联合查询';
COMMENT ON INDEX idx_medicine_category_relations_category IS '分类关联查询';


-- ---------------------------------------------------------
-- 6. 函数
-- ---------------------------------------------------------

COMMENT ON FUNCTION update_updated_at_column() IS '触发器函数：更新记录时自动维护 updated_at';
