-- =========================================================
-- 千方记 - 小药箱 V1 数据库结构
-- PostgreSQL
-- =========================================================


-- ---------------------------------------------------------
-- 1. UUID 支持
-- ---------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ---------------------------------------------------------
-- 2. 药品分类表
-- 由开发人员预置，全局共享；用户只能选择，不能增删改
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS medicine_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 分类名称
    name VARCHAR(50) NOT NULL UNIQUE,

    -- 排序，数字越小越靠前
    sort_order INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ---------------------------------------------------------
-- 3. 药箱主表
-- 所有用户共用一张表，通过 user_id 区分各自的药箱
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS medicine_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 所属用户
    -- 目前用户系统还没建立，所以暂时不添加外键
    user_id UUID NOT NULL,

    -- 所属分类，一个药品只属于一个分类
    category_id UUID NOT NULL,

    -- 药品名称
    -- 注意：不能 UNIQUE，同一种药可能存在多盒/多批次
    name VARCHAR(100) NOT NULL,

    -- 规格，例如：0.25g × 24粒
    specification VARCHAR(100),

    -- 剂型，例如：胶囊、颗粒剂、糖浆
    dosage_form VARCHAR(50),

    -- 当前剩余数量
    quantity INTEGER NOT NULL DEFAULT 1,

    -- 单位，原样保存用户选择或输入的文本，例如：粒 / 袋 / 瓶 / 支 / 片
    unit VARCHAR(20) NOT NULL,

    -- 有效期
    expiration_date DATE,

    -- 生产厂家
    manufacturer VARCHAR(150),

    -- 功效标签，例如：{退烧,止痛}
    efficacy TEXT[] NOT NULL DEFAULT '{}',

    -- 每次用量，单位同 unit，例如 0.5 表示半粒
    dose_per_time NUMERIC(6, 2),

    -- 每天服用次数
    times_per_day SMALLINT,

    -- 用药时段，可多选，例如：{before-meal,bedtime}
    medication_timings TEXT[] NOT NULL DEFAULT '{}',

    -- 存放位置
    location VARCHAR(100),

    -- 药品主图
    image_url TEXT,

    -- 用户备注
    note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- 分类被药品引用时禁止删除
    CONSTRAINT fk_medicine_items_category
        FOREIGN KEY (category_id)
        REFERENCES medicine_categories(id)
        ON DELETE RESTRICT,

    -- 库存不能小于 0
    CONSTRAINT medicine_items_quantity_check
        CHECK (quantity >= 0),

    -- 每次用量必须大于 0
    CONSTRAINT medicine_items_dose_per_time_check
        CHECK (dose_per_time > 0),

    -- 每天次数必须大于 0
    CONSTRAINT medicine_items_times_per_day_check
        CHECK (times_per_day > 0)
);


-- ---------------------------------------------------------
-- 4. 就诊主表
-- 所有用户共用一张表，通过 user_id 区分
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS visit_records (
    -- 由客户端创建草稿时生成，重试沿用
    id UUID PRIMARY KEY,

    -- 所属用户
    -- 目前用户系统还没建立，所以暂时不添加外键
    user_id UUID NOT NULL,

    -- 实际就诊日期
    visit_date DATE NOT NULL,

    -- NULL 表示初诊；非空表示复诊，值为同组根 UUID
    -- 不是外键：删除根就诊时不影响同组复诊
    initial_visit_id UUID,

    -- 医院或诊所
    hospital_name VARCHAR(150),

    -- 科室
    department VARCHAR(20),

    -- 医生
    doctor_name VARCHAR(20),

    -- 症状标签，包含自定义标签
    symptom_tags TEXT[] NOT NULL DEFAULT '{}',

    -- 主诉描述
    symptom_note VARCHAR(200),

    -- 诊断
    diagnosis VARCHAR(50),

    -- 处方原文
    prescription VARCHAR(500),

    -- 医嘱
    advice TEXT,

    -- 照片对象存储 key，数组顺序即显示顺序
    photo_keys TEXT[] NOT NULL DEFAULT '{}',

    -- 乐观并发版本
    version INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT visit_records_version_check
        CHECK (version >= 1),

    -- 复诊不能关联自身
    CONSTRAINT visit_records_initial_visit_id_check
        CHECK (initial_visit_id IS NULL OR initial_visit_id <> id),

    -- 每次就诊最多 9 张照片
    CONSTRAINT visit_records_photo_keys_check
        CHECK (cardinality(photo_keys) <= 9)
);


-- ---------------------------------------------------------
-- 5. 就诊用药表
-- 保存当次用药快照，与药箱记录相互独立
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS visit_medicines (
    -- 由客户端生成，编辑沿用
    id UUID PRIMARY KEY,

    -- 所属就诊
    visit_id UUID NOT NULL,

    -- 可选关联的药箱记录
    medicine_id UUID,

    -- 药名快照
    name VARCHAR(100) NOT NULL,

    -- 剂量单位快照
    unit VARCHAR(20) NOT NULL,

    -- 每次用量
    dose_per_time NUMERIC(6, 2),

    -- 每天服用次数
    times_per_day SMALLINT,

    -- 用药时段，可多选
    medication_timings TEXT[] NOT NULL DEFAULT '{}',

    -- 服法说明
    usage_note VARCHAR(500),

    -- 显示顺序，从 0 开始
    sort_order INTEGER NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- 就诊删除时级联删除用药
    CONSTRAINT fk_visit_medicines_visit
        FOREIGN KEY (visit_id)
        REFERENCES visit_records(id)
        ON DELETE CASCADE,

    -- 药箱删除时置空，用药快照保留
    CONSTRAINT fk_visit_medicines_medicine
        FOREIGN KEY (medicine_id)
        REFERENCES medicine_items(id)
        ON DELETE SET NULL,

    CONSTRAINT visit_medicines_dose_per_time_check
        CHECK (dose_per_time > 0),

    CONSTRAINT visit_medicines_times_per_day_check
        CHECK (times_per_day > 0)
);


-- ---------------------------------------------------------
-- 6. 常用索引
-- ---------------------------------------------------------

-- 查询某个用户的药品
CREATE INDEX IF NOT EXISTS idx_medicine_items_user_id
ON medicine_items(user_id);

-- 按药品名称查询
CREATE INDEX IF NOT EXISTS idx_medicine_items_name
ON medicine_items(name);

-- 查询即将过期 / 已过期药品
CREATE INDEX IF NOT EXISTS idx_medicine_items_expiration_date
ON medicine_items(expiration_date);

-- 用户 + 药品名称联合查询
CREATE INDEX IF NOT EXISTS idx_medicine_items_user_name
ON medicine_items(user_id, name);

-- 用户 + 分类联合查询
CREATE INDEX IF NOT EXISTS idx_medicine_items_user_category
ON medicine_items(user_id, category_id);

-- 按分组根 UUID 查询同组复诊
CREATE INDEX IF NOT EXISTS idx_visit_records_initial_visit
ON visit_records(initial_visit_id, visit_date, id);

-- 用户就诊列表排序
CREATE INDEX IF NOT EXISTS idx_visit_records_user_list
ON visit_records(user_id, visit_date DESC, created_at DESC, id DESC);

-- 按就诊读取用药并排序
CREATE INDEX IF NOT EXISTS idx_visit_medicines_visit_sort
ON visit_medicines(visit_id, sort_order);

-- 药箱删除置空及按药箱反查用药
CREATE INDEX IF NOT EXISTS idx_visit_medicines_medicine_id
ON visit_medicines(medicine_id);

-- 同一就诊不重复关联同一药箱记录，medicine_id 为空时不受限制
CREATE UNIQUE INDEX IF NOT EXISTS uq_visit_medicines_visit_medicine
ON visit_medicines(visit_id, medicine_id);


-- ---------------------------------------------------------
-- 7. 自动维护 updated_at
-- ---------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


DROP TRIGGER IF EXISTS update_medicine_items_updated_at
ON medicine_items;

CREATE TRIGGER update_medicine_items_updated_at
BEFORE UPDATE ON medicine_items
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


DROP TRIGGER IF EXISTS update_medicine_categories_updated_at
ON medicine_categories;

CREATE TRIGGER update_medicine_categories_updated_at
BEFORE UPDATE ON medicine_categories
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


DROP TRIGGER IF EXISTS update_visit_records_updated_at
ON visit_records;

CREATE TRIGGER update_visit_records_updated_at
BEFORE UPDATE ON visit_records
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


DROP TRIGGER IF EXISTS update_visit_medicines_updated_at
ON visit_medicines;

CREATE TRIGGER update_visit_medicines_updated_at
BEFORE UPDATE ON visit_medicines
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();


-- ---------------------------------------------------------
-- 8. 初始化常用分类
-- ---------------------------------------------------------

INSERT INTO medicine_categories (name, sort_order)
VALUES
    ('感冒发烧', 10),
    ('止痛', 20),
    ('肠胃', 30),
    ('过敏', 40),
    ('外伤', 50),
    ('抗感染', 60),
    ('慢性病', 70),
    ('其他', 999)
ON CONFLICT (name) DO NOTHING;
