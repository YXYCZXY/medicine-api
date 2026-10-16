-- =========================================================
-- 千方记 - 小药箱 V1 数据库注释
-- PostgreSQL
-- 需在 init.sql 执行之后执行，可重复执行
-- =========================================================


-- ---------------------------------------------------------
-- 1. 药品分类表
-- ---------------------------------------------------------

COMMENT ON TABLE medicine_categories IS '药品分类表，由开发人员预置、全局共享，用户只能选择';

COMMENT ON COLUMN medicine_categories.id IS '主键 ID';
COMMENT ON COLUMN medicine_categories.name IS '分类名称，唯一';
COMMENT ON COLUMN medicine_categories.sort_order IS '排序，数字越小越靠前';
COMMENT ON COLUMN medicine_categories.created_at IS '创建时间';
COMMENT ON COLUMN medicine_categories.updated_at IS '更新时间';


-- ---------------------------------------------------------
-- 2. 药箱主表
-- ---------------------------------------------------------

COMMENT ON TABLE medicine_items IS '药箱主表，记录用户药箱中的药品，所有用户共用并通过 user_id 区分';

COMMENT ON COLUMN medicine_items.id IS '主键 ID';
COMMENT ON COLUMN medicine_items.user_id IS '所属用户 ID（用户系统未建立，暂无外键）';
COMMENT ON COLUMN medicine_items.category_id IS '所属分类 ID，关联 medicine_categories.id，一个药品只属于一个分类';
COMMENT ON COLUMN medicine_items.name IS '药品名称（同一种药可能存在多盒/多批次，不唯一）';
COMMENT ON COLUMN medicine_items.specification IS '规格，例如：0.25g × 24粒';
COMMENT ON COLUMN medicine_items.dosage_form IS '剂型，例如：胶囊、颗粒剂、糖浆';
COMMENT ON COLUMN medicine_items.quantity IS '当前剩余数量，不能小于 0';
COMMENT ON COLUMN medicine_items.unit IS '单位，原样保存文本，例如：粒、袋、瓶、支、片';
COMMENT ON COLUMN medicine_items.expiration_date IS '有效期';
COMMENT ON COLUMN medicine_items.manufacturer IS '生产厂家';
COMMENT ON COLUMN medicine_items.efficacy IS '功效标签数组，例如：{退烧,止痛}';
COMMENT ON COLUMN medicine_items.dose_per_time IS '每次用量，单位同 unit，例如 0.5 表示半粒';
COMMENT ON COLUMN medicine_items.times_per_day IS '每天服用次数';
COMMENT ON COLUMN medicine_items.medication_timings IS '用药时段数组，可多选：before-meal-饭前，after-meal-饭后，bedtime-晚睡前，morning-早晨醒后';
COMMENT ON COLUMN medicine_items.location IS '存放位置';
COMMENT ON COLUMN medicine_items.image_url IS '药品主图 URL';
COMMENT ON COLUMN medicine_items.note IS '用户备注';
COMMENT ON COLUMN medicine_items.created_at IS '创建时间';
COMMENT ON COLUMN medicine_items.updated_at IS '更新时间';

COMMENT ON CONSTRAINT fk_medicine_items_category ON medicine_items IS '药品分类外键，分类被药品引用时禁止删除';
COMMENT ON CONSTRAINT medicine_items_quantity_check ON medicine_items IS '库存不能小于 0';
COMMENT ON CONSTRAINT medicine_items_dose_per_time_check ON medicine_items IS '每次用量必须大于 0';
COMMENT ON CONSTRAINT medicine_items_times_per_day_check ON medicine_items IS '每天次数必须大于 0';


-- ---------------------------------------------------------
-- 3. 就诊主表
-- ---------------------------------------------------------

COMMENT ON TABLE visit_records IS '就诊主表，记录用户每次就诊信息，所有用户共用并通过 user_id 区分';

COMMENT ON COLUMN visit_records.id IS '主键 ID，由客户端创建草稿时生成 UUID v4，重试沿用';
COMMENT ON COLUMN visit_records.user_id IS '所属用户 ID（用户系统未建立，暂无外键）';
COMMENT ON COLUMN visit_records.visit_date IS '实际就诊日期';
COMMENT ON COLUMN visit_records.initial_visit_id IS 'NULL 表示初诊；非空表示复诊，值为同组根 UUID，不是外键，允许指向已删除的就诊';
COMMENT ON COLUMN visit_records.hospital_name IS '医院或诊所名称';
COMMENT ON COLUMN visit_records.department IS '科室';
COMMENT ON COLUMN visit_records.doctor_name IS '医生姓名';
COMMENT ON COLUMN visit_records.symptom_tags IS '症状标签数组，保存选中的症状文字，包含自定义标签';
COMMENT ON COLUMN visit_records.symptom_note IS '主诉描述';
COMMENT ON COLUMN visit_records.diagnosis IS '诊断，可空';
COMMENT ON COLUMN visit_records.prescription IS '处方原文';
COMMENT ON COLUMN visit_records.advice IS '医嘱';
COMMENT ON COLUMN visit_records.photo_keys IS '照片对象存储 key 数组，数组顺序即显示顺序，只由服务端写入';
COMMENT ON COLUMN visit_records.version IS '乐观并发版本，成功编辑加 1';
COMMENT ON COLUMN visit_records.created_at IS '创建时间';
COMMENT ON COLUMN visit_records.updated_at IS '更新时间';

COMMENT ON CONSTRAINT visit_records_version_check ON visit_records IS '版本号不能小于 1';
COMMENT ON CONSTRAINT visit_records_initial_visit_id_check ON visit_records IS '复诊不能关联自身';
COMMENT ON CONSTRAINT visit_records_photo_keys_check ON visit_records IS '每次就诊最多 9 张照片';


-- ---------------------------------------------------------
-- 4. 就诊用药表
-- ---------------------------------------------------------

COMMENT ON TABLE visit_medicines IS '就诊用药表，保存当次就诊的用药快照，与药箱记录相互独立';

COMMENT ON COLUMN visit_medicines.id IS '主键 ID，由客户端生成稳定 UUID v4，编辑沿用';
COMMENT ON COLUMN visit_medicines.visit_id IS '所属就诊 ID，就诊删除时级联删除';
COMMENT ON COLUMN visit_medicines.medicine_id IS '可选关联的药箱记录 ID，药箱删除时置空';
COMMENT ON COLUMN visit_medicines.name IS '当次就诊记录的药名快照';
COMMENT ON COLUMN visit_medicines.unit IS '当次剂量单位快照';
COMMENT ON COLUMN visit_medicines.dose_per_time IS '当次每次用量，单位同 unit';
COMMENT ON COLUMN visit_medicines.times_per_day IS '当次每天服用次数';
COMMENT ON COLUMN visit_medicines.medication_timings IS '用药时段数组，可多选：before-meal-饭前，after-meal-饭后，bedtime-晚睡前，morning-早晨醒后';
COMMENT ON COLUMN visit_medicines.usage_note IS '服法说明，例如按需、外用等无法仅靠数值表达的用法';
COMMENT ON COLUMN visit_medicines.sort_order IS '显示顺序，按请求数组顺序从 0 开始';
COMMENT ON COLUMN visit_medicines.created_at IS '创建时间';
COMMENT ON COLUMN visit_medicines.updated_at IS '更新时间';

COMMENT ON CONSTRAINT fk_visit_medicines_visit ON visit_medicines IS '所属就诊外键，就诊删除时级联删除用药';
COMMENT ON CONSTRAINT fk_visit_medicines_medicine ON visit_medicines IS '药箱记录外键，药箱删除时置空，用药快照保留';
COMMENT ON CONSTRAINT visit_medicines_dose_per_time_check ON visit_medicines IS '每次用量必须大于 0';
COMMENT ON CONSTRAINT visit_medicines_times_per_day_check ON visit_medicines IS '每天次数必须大于 0';


-- ---------------------------------------------------------
-- 5. 索引
-- ---------------------------------------------------------

COMMENT ON INDEX idx_medicine_items_user_id IS '查询某个用户的药品';
COMMENT ON INDEX idx_medicine_items_name IS '按药品名称查询';
COMMENT ON INDEX idx_medicine_items_expiration_date IS '查询即将过期 / 已过期药品';
COMMENT ON INDEX idx_medicine_items_user_name IS '用户 + 药品名称联合查询';
COMMENT ON INDEX idx_medicine_items_user_category IS '用户 + 分类联合查询';
COMMENT ON INDEX idx_visit_records_initial_visit IS '按分组根 UUID 查询同组复诊';
COMMENT ON INDEX idx_visit_records_user_list IS '用户就诊列表排序';
COMMENT ON INDEX idx_visit_medicines_visit_sort IS '按就诊读取用药并排序';
COMMENT ON INDEX idx_visit_medicines_medicine_id IS '药箱删除置空及按药箱反查用药';
COMMENT ON INDEX uq_visit_medicines_visit_medicine IS '同一就诊不重复关联同一药箱记录，medicine_id 为空时不受限制';


-- ---------------------------------------------------------
-- 6. 函数
-- ---------------------------------------------------------

COMMENT ON FUNCTION update_updated_at_column() IS '触发器函数：更新记录时自动维护 updated_at';
