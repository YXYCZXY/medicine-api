BEGIN;

-- 半粒等单次剂量必须按原值扣减，不能取整。
ALTER TABLE medicine_items ALTER COLUMN quantity TYPE DECIMAL(12,2);
ALTER TABLE health_reminder_checkins
  ADD COLUMN stock_medicine_id UUID,
  ADD COLUMN stock_quantity DECIMAL(12,2),
  ADD COLUMN stock_unit VARCHAR(20),
  ADD CONSTRAINT health_reminder_checkins_stock_check CHECK (
    (stock_medicine_id IS NULL AND stock_quantity IS NULL AND stock_unit IS NULL) OR
    (stock_medicine_id IS NOT NULL AND stock_quantity IS NOT NULL AND stock_quantity > 0 AND stock_unit IS NOT NULL)
  );
-- 保存实际扣减快照，不随提醒改药或药箱删除而改写，不回溯扣减历史打卡。
COMMENT ON COLUMN health_reminder_checkins.stock_medicine_id IS '本次实际扣库存的药品 ID 快照，无外键；删除后取消打卡不重建药品';
COMMENT ON COLUMN health_reminder_checkins.stock_quantity IS '本次实际扣减数量；取消打卡后清空，历史打卡默认空';
COMMENT ON COLUMN health_reminder_checkins.stock_unit IS '扣减时的库存单位，撤销时校验';

COMMIT;
