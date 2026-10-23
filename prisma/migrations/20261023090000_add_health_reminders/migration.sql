BEGIN;

-- CreateTable
CREATE TABLE "health_reminders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(10) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "note" VARCHAR(2000),
    "frequency" VARCHAR(10) NOT NULL,
    "remind_date" DATE,
    "remind_time" VARCHAR(5),
    "starts_on" DATE NOT NULL,
    "record_blood_pressure" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_reminder_medicines" (
    "reminder_id" UUID NOT NULL,
    "medicine_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "dose_per_time" DECIMAL(6,2),
    "times_per_day" SMALLINT,
    "medication_timings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_reminder_medicines_pkey" PRIMARY KEY ("reminder_id")
);

-- CreateTable
CREATE TABLE "health_reminder_checkins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reminder_id" UUID NOT NULL,
    "occurrence_date" DATE NOT NULL,
    "scheduled_time" VARCHAR(5),
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_reminder_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blood_pressure_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "checkin_id" UUID,
    "systolic" SMALLINT NOT NULL,
    "diastolic" SMALLINT NOT NULL,
    "pulse" SMALLINT NOT NULL,
    "slot" VARCHAR(10) NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blood_pressure_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medicine_expiry_states" (
    "medicine_id" UUID NOT NULL,
    "expiration_date" DATE NOT NULL,
    "handled_at" TIMESTAMPTZ(6),
    "dismissed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medicine_expiry_states_pkey" PRIMARY KEY ("medicine_id","expiration_date")
);

-- CreateIndex
CREATE INDEX "idx_health_reminders_user_list" ON "health_reminders"("user_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "health_reminder_medicines_medicine_id_idx" ON "health_reminder_medicines"("medicine_id");

-- CreateIndex
CREATE UNIQUE INDEX "health_reminder_checkins_reminder_id_occurrence_date_key" ON "health_reminder_checkins"("reminder_id", "occurrence_date");

-- CreateIndex
CREATE UNIQUE INDEX "blood_pressure_records_checkin_id_key" ON "blood_pressure_records"("checkin_id");

-- CreateIndex
CREATE INDEX "idx_blood_pressure_user_measured" ON "blood_pressure_records"("user_id", "measured_at" DESC, "id");

-- AddForeignKey
ALTER TABLE "health_reminder_medicines" ADD CONSTRAINT "health_reminder_medicines_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "health_reminders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "health_reminder_medicines" ADD CONSTRAINT "health_reminder_medicines_medicine_id_fkey" FOREIGN KEY ("medicine_id") REFERENCES "medicine_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "health_reminder_checkins" ADD CONSTRAINT "health_reminder_checkins_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "health_reminders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "blood_pressure_records" ADD CONSTRAINT "blood_pressure_records_checkin_id_fkey" FOREIGN KEY ("checkin_id") REFERENCES "health_reminder_checkins"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "medicine_expiry_states" ADD CONSTRAINT "medicine_expiry_states_medicine_id_fkey" FOREIGN KEY ("medicine_id") REFERENCES "medicine_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 固定类型组合，防止绕过接口写入不能执行的规则。
ALTER TABLE health_reminders
  ADD CONSTRAINT health_reminders_type_check CHECK (type IN ('med', 'daily', 'visit')),
  ADD CONSTRAINT health_reminders_frequency_check CHECK (frequency IN ('daily', 'weekdays', 'once')),
  ADD CONSTRAINT health_reminders_title_check CHECK (length(btrim(title)) > 0),
  ADD CONSTRAINT health_reminders_version_check CHECK (version >= 1),
  ADD CONSTRAINT health_reminders_date_check CHECK (
    (frequency = 'once' AND remind_date IS NOT NULL) OR
    (frequency IN ('daily', 'weekdays') AND remind_date IS NULL)
  ),
  ADD CONSTRAINT health_reminders_time_check CHECK (
    (type = 'visit' AND frequency = 'once' AND remind_time IS NULL) OR
    (type IN ('med', 'daily') AND remind_time IS NOT NULL AND remind_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  ),
  ADD CONSTRAINT health_reminders_blood_pressure_check CHECK (type = 'daily' OR NOT record_blood_pressure);

ALTER TABLE health_reminder_medicines
  ADD CONSTRAINT health_reminder_medicines_name_check CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT health_reminder_medicines_unit_check CHECK (length(btrim(unit)) > 0),
  ADD CONSTRAINT health_reminder_medicines_dose_check CHECK (dose_per_time > 0),
  ADD CONSTRAINT health_reminder_medicines_times_check CHECK (times_per_day > 0),
  ADD CONSTRAINT health_reminder_medicines_timings_check CHECK (cardinality(medication_timings) <= 10);

ALTER TABLE health_reminder_checkins
  ADD CONSTRAINT health_reminder_checkins_version_check CHECK (version >= 1),
  ADD CONSTRAINT health_reminder_checkins_time_check CHECK (scheduled_time IS NULL OR scheduled_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE blood_pressure_records
  ADD CONSTRAINT blood_pressure_records_values_check CHECK (systolic > 0 AND diastolic > 0 AND pulse > 0),
  ADD CONSTRAINT blood_pressure_records_slot_check CHECK (slot IN ('morning', 'afternoon', 'bedtime'));

ALTER TABLE medicine_expiry_states
  ADD CONSTRAINT medicine_expiry_states_version_check CHECK (version >= 1),
  ADD CONSTRAINT medicine_expiry_states_status_check CHECK (handled_at IS NULL OR dismissed_at IS NULL);

CREATE TRIGGER update_health_reminders_updated_at BEFORE UPDATE ON health_reminders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_health_reminder_medicines_updated_at BEFORE UPDATE ON health_reminder_medicines
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_health_reminder_checkins_updated_at BEFORE UPDATE ON health_reminder_checkins
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_blood_pressure_records_updated_at BEFORE UPDATE ON blood_pressure_records
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_medicine_expiry_states_updated_at BEFORE UPDATE ON medicine_expiry_states
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE health_reminders IS '用户创建的健康提醒规则，按业务时区计算执行日';
COMMENT ON COLUMN health_reminders.id IS '客户端生成 UUID v4，重试沿用，避免重复入箱';
COMMENT ON COLUMN health_reminders.user_id IS '所属用户，用户系统未建立，暂不建外键';
COMMENT ON COLUMN health_reminders.type IS 'med 用药、daily 日常、visit 复查就医；临期不存本表';
COMMENT ON COLUMN health_reminders.title IS '提醒事项';
COMMENT ON COLUMN health_reminders.note IS '备注，空文本存 NULL';
COMMENT ON COLUMN health_reminders.frequency IS 'daily 每天、weekdays 周一至周五、once 仅此一次';
COMMENT ON COLUMN health_reminders.remind_date IS '一次性提醒的目标日期，重复提醒为空';
COMMENT ON COLUMN health_reminders.remind_time IS 'HH:mm；复查就医为空，按全天事项处理';
COMMENT ON COLUMN health_reminders.starts_on IS '创建时的业务日期，重复提醒从此日起生效';
COMMENT ON COLUMN health_reminders.record_blood_pressure IS '仅日常提醒可开启，完成时需同时保存血压';
COMMENT ON COLUMN health_reminders.version IS '规则版本，编辑成功加一';

COMMENT ON TABLE health_reminder_medicines IS '每条用药提醒的一对一药品快照，药箱变化不覆盖快照';
COMMENT ON COLUMN health_reminder_medicines.reminder_id IS '所属提醒，删除时级联删除';
COMMENT ON COLUMN health_reminder_medicines.medicine_id IS '可选药箱关联，药箱删除后置空，快照保留';
COMMENT ON COLUMN health_reminder_medicines.name IS '药名快照';
COMMENT ON COLUMN health_reminder_medicines.unit IS '剂量单位快照';
COMMENT ON COLUMN health_reminder_medicines.dose_per_time IS '单次剂量，空表示未填写';
COMMENT ON COLUMN health_reminder_medicines.times_per_day IS '每日服药次数，仅用于展示，不扩展提醒时刻';
COMMENT ON COLUMN health_reminder_medicines.medication_timings IS '用药时段，如饭前、饭后、睡前、晨起';

COMMENT ON TABLE health_reminder_checkins IS '按提醒和执行日唯一保存完成状态，取消时保留记录';
COMMENT ON COLUMN health_reminder_checkins.occurrence_date IS '本次提醒所属日期，不是实际点击日期';
COMMENT ON COLUMN health_reminder_checkins.scheduled_time IS '首次操作时的计划时刻快照';
COMMENT ON COLUMN health_reminder_checkins.completed_at IS '实际完成时间，NULL 表示待完成或已取消';
COMMENT ON COLUMN health_reminder_checkins.version IS '当次打卡的独立版本，防止并发覆盖';

COMMENT ON TABLE blood_pressure_records IS '独立血压测量；取消打卡、删除提醒均保留，不产生医学诊断';
COMMENT ON COLUMN blood_pressure_records.user_id IS '所属用户，独立查询必须按此隔离';
COMMENT ON COLUMN blood_pressure_records.checkin_id IS '可选的一对一打卡关联，打卡删除后置空';
COMMENT ON COLUMN blood_pressure_records.systolic IS '收缩压，单位 mmHg';
COMMENT ON COLUMN blood_pressure_records.diastolic IS '舒张压，单位 mmHg';
COMMENT ON COLUMN blood_pressure_records.pulse IS '脉搏，单位次/分';
COMMENT ON COLUMN blood_pressure_records.slot IS 'morning 晨起、afternoon 午后、bedtime 睡前';
COMMENT ON COLUMN blood_pressure_records.measured_at IS '实际测量时间，带时区保存';

COMMENT ON TABLE medicine_expiry_states IS '仅保存药品某个有效期的处理或忽略状态；无行表示待处理';
COMMENT ON COLUMN medicine_expiry_states.medicine_id IS '药箱药品，删除药品时级联删除';
COMMENT ON COLUMN medicine_expiry_states.expiration_date IS '状态对应的有效期，改期后不继承旧状态';
COMMENT ON COLUMN medicine_expiry_states.handled_at IS '标记处理时间，不改变库存';
COMMENT ON COLUMN medicine_expiry_states.dismissed_at IS '忽略时间，忽略后不展示当前有效期卡片';
COMMENT ON COLUMN medicine_expiry_states.version IS '状态版本，首次操作为一';

COMMIT;
