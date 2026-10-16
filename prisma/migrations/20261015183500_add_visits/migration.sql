/*
  - 新增就诊主表 visit_records：initial_visit_id 为 NULL 表示初诊，非空表示复诊，值为同组根 UUID，不建外键。
  - photo_keys 按顺序保存私有对象存储 key，最多 9 个；文件本身不进数据库。
  - 新增就诊用药表 visit_medicines：保存当时用药快照；就诊删除 CASCADE，药箱删除 SET NULL。
*/

-- CreateTable
CREATE TABLE "visit_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "visit_date" DATE NOT NULL,
    "initial_visit_id" UUID,
    "hospital_name" VARCHAR(150),
    "department" VARCHAR(20),
    "doctor_name" VARCHAR(20),
    "symptom_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "symptom_note" VARCHAR(200),
    "diagnosis" VARCHAR(50),
    "prescription" VARCHAR(500),
    "advice" TEXT,
    "photo_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "visit_records_version_check" CHECK ("version" >= 1),
    CONSTRAINT "visit_records_initial_visit_id_check" CHECK ("initial_visit_id" IS NULL OR "initial_visit_id" <> "id"),
    CONSTRAINT "visit_records_photo_keys_check" CHECK (cardinality("photo_keys") <= 9)
);

-- CreateTable
CREATE TABLE "visit_medicines" (
    "id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "medicine_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "dose_per_time" DECIMAL(6,2),
    "times_per_day" SMALLINT,
    "medication_timings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "usage_note" VARCHAR(500),
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_medicines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "visit_medicines_dose_per_time_check" CHECK ("dose_per_time" > 0),
    CONSTRAINT "visit_medicines_times_per_day_check" CHECK ("times_per_day" > 0)
);

-- CreateIndex
CREATE INDEX "idx_visit_records_initial_visit" ON "visit_records"("initial_visit_id", "visit_date", "id");

-- CreateIndex
CREATE INDEX "idx_visit_records_user_list" ON "visit_records"("user_id", "visit_date" DESC, "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "idx_visit_medicines_visit_sort" ON "visit_medicines"("visit_id", "sort_order");

-- CreateIndex
CREATE INDEX "idx_visit_medicines_medicine_id" ON "visit_medicines"("medicine_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_visit_medicines_visit_medicine" ON "visit_medicines"("visit_id", "medicine_id");

-- AddForeignKey
ALTER TABLE "visit_medicines" ADD CONSTRAINT "fk_visit_medicines_visit" FOREIGN KEY ("visit_id") REFERENCES "visit_records"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "visit_medicines" ADD CONSTRAINT "fk_visit_medicines_medicine" FOREIGN KEY ("medicine_id") REFERENCES "medicine_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- UpdatedAtTrigger
CREATE TRIGGER update_visit_records_updated_at
BEFORE UPDATE ON visit_records
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_visit_medicines_updated_at
BEFORE UPDATE ON visit_medicines
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- AddComment
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

COMMENT ON INDEX idx_visit_records_initial_visit IS '按分组根 UUID 查询同组复诊';
COMMENT ON INDEX idx_visit_records_user_list IS '用户就诊列表排序';

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

COMMENT ON INDEX idx_visit_medicines_visit_sort IS '按就诊读取用药并排序';
COMMENT ON INDEX idx_visit_medicines_medicine_id IS '药箱删除置空及按药箱反查用药';
COMMENT ON INDEX uq_visit_medicines_visit_medicine IS '同一就诊不重复关联同一药箱记录，medicine_id 为空时不受限制';
