/*
  - 药品与分类由多对多关联表改为 medicine_items.category_id 单外键（ON DELETE RESTRICT），并删除 medicine_category_relations。
  - unit 由 medicine_unit 枚举改为 VARCHAR(20) 文本。
  - efficacy 由 TEXT 改为 TEXT[]。
  - medication_timing 单值枚举替换为 medication_timings TEXT[]。
  - 删除 medicine_unit、medication_timing 两个枚举类型。
*/

-- PreCheck：存在无法自动转换的历史数据时中止，避免静默丢弃
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM medicine_category_relations
        GROUP BY medicine_item_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION '存在关联多个分类的药品，请先人工确认保留的分类后再迁移';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM medicine_items
        WHERE medication_timing IN ('WITH_MEAL', 'ANY_TIME')
    ) THEN
        RAISE EXCEPTION '存在 WITH_MEAL / ANY_TIME 用药时段，前端无对应选项，请先确认处理方式后再迁移';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM medicine_categories
        WHERE name = '其他'
    ) THEN
        RAISE EXCEPTION '缺少预置分类“其他”，无法为无分类的历史药品回填 category_id';
    END IF;
END
$$;

-- Category：关联表 -> medicine_items.category_id
ALTER TABLE "medicine_items" ADD COLUMN "category_id" UUID;

UPDATE "medicine_items" AS m
SET "category_id" = r."category_id"
FROM "medicine_category_relations" AS r
WHERE r."medicine_item_id" = m."id";

UPDATE "medicine_items"
SET "category_id" = (
    SELECT "id" FROM "medicine_categories" WHERE "name" = '其他'
)
WHERE "category_id" IS NULL;

ALTER TABLE "medicine_items" ALTER COLUMN "category_id" SET NOT NULL;

ALTER TABLE "medicine_items"
ADD CONSTRAINT "fk_medicine_items_category"
    FOREIGN KEY ("category_id")
    REFERENCES "medicine_categories"("id")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION;

CREATE INDEX "idx_medicine_items_user_category"
ON "medicine_items"("user_id", "category_id");

DROP TABLE "medicine_category_relations";

-- Unit：枚举 -> 文本
ALTER TABLE "medicine_items"
ALTER COLUMN "unit" SET DATA TYPE VARCHAR(20)
USING CASE "unit"::TEXT
    WHEN 'GRAIN'  THEN '粒'
    WHEN 'BAG'    THEN '袋'
    WHEN 'BOTTLE' THEN '瓶'
END;

-- Efficacy：文本 -> 文本数组
ALTER TABLE "medicine_items"
ALTER COLUMN "efficacy" SET DATA TYPE TEXT[]
USING CASE
    WHEN "efficacy" IS NULL OR btrim("efficacy") = '' THEN ARRAY[]::TEXT[]
    ELSE ARRAY[btrim("efficacy")]
END,
ALTER COLUMN "efficacy" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "efficacy" SET NOT NULL;

-- MedicationTimings：单值枚举 -> 文本数组
ALTER TABLE "medicine_items"
ADD COLUMN "medication_timings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "medicine_items"
SET "medication_timings" = ARRAY[
    CASE "medication_timing"::TEXT
        WHEN 'BEFORE_MEAL'  THEN 'before-meal'
        WHEN 'AFTER_MEAL'   THEN 'after-meal'
        WHEN 'BEFORE_SLEEP' THEN 'bedtime'
        WHEN 'ON_WAKING'    THEN 'morning'
    END
]
WHERE "medication_timing" IN ('BEFORE_MEAL', 'AFTER_MEAL', 'BEFORE_SLEEP', 'ON_WAKING');

ALTER TABLE "medicine_items" DROP COLUMN "medication_timing";

-- DropEnum
DROP TYPE "medicine_unit";
DROP TYPE "medication_timing";

-- AddComment
COMMENT ON TABLE medicine_categories IS '药品分类表，由开发人员预置、全局共享，用户只能选择';
COMMENT ON TABLE medicine_items IS '药箱主表，记录用户药箱中的药品，所有用户共用并通过 user_id 区分';

COMMENT ON COLUMN medicine_items.category_id IS '所属分类 ID，关联 medicine_categories.id，一个药品只属于一个分类';
COMMENT ON COLUMN medicine_items.unit IS '单位，原样保存文本，例如：粒、袋、瓶、支、片';
COMMENT ON COLUMN medicine_items.efficacy IS '功效标签数组，例如：{退烧,止痛}';
COMMENT ON COLUMN medicine_items.medication_timings IS '用药时段数组，可多选：before-meal-饭前，after-meal-饭后，bedtime-晚睡前，morning-早晨醒后';

COMMENT ON CONSTRAINT fk_medicine_items_category ON medicine_items IS '药品分类外键，分类被药品引用时禁止删除';

COMMENT ON INDEX idx_medicine_items_user_category IS '用户 + 分类联合查询';
