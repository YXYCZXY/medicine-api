/*
  Warnings:

  - You are about to drop the column `usage` on the `medicine_items` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "medication_timing" AS ENUM ('BEFORE_MEAL', 'AFTER_MEAL', 'WITH_MEAL', 'ON_WAKING', 'BEFORE_SLEEP', 'ANY_TIME');

-- AlterTable
ALTER TABLE "medicine_items" DROP COLUMN "usage",
ADD COLUMN     "dose_per_time" DECIMAL(6,2),
ADD COLUMN     "medication_timing" "medication_timing",
ADD COLUMN     "times_per_day" SMALLINT;

-- AddCheckConstraint
ALTER TABLE "medicine_items"
ADD CONSTRAINT "medicine_items_dose_per_time_check" CHECK ("dose_per_time" > 0),
ADD CONSTRAINT "medicine_items_times_per_day_check" CHECK ("times_per_day" > 0);

-- AddComment
COMMENT ON TYPE medication_timing IS '服药时机：BEFORE_MEAL-饭前，AFTER_MEAL-饭后，WITH_MEAL-随餐，ON_WAKING-早起空腹，BEFORE_SLEEP-睡前，ANY_TIME-不限时间';

COMMENT ON COLUMN medicine_items.dose_per_time IS '每次用量，单位同 unit，例如 0.5 表示半粒';
COMMENT ON COLUMN medicine_items.times_per_day IS '每天服用次数';
COMMENT ON COLUMN medicine_items.medication_timing IS '服药时机';

COMMENT ON CONSTRAINT medicine_items_dose_per_time_check ON medicine_items IS '每次用量必须大于 0';
COMMENT ON CONSTRAINT medicine_items_times_per_day_check ON medicine_items IS '每天次数必须大于 0';
