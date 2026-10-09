-- =========================================================
-- 千方记 - 小药箱 V1 数据库结构
-- PostgreSQL
-- =========================================================


-- ---------------------------------------------------------
-- 1. UUID 支持
-- ---------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ---------------------------------------------------------
-- 2. 药品数量单位
-- ---------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type
        WHERE typname = 'medicine_unit'
    ) THEN
        CREATE TYPE medicine_unit AS ENUM (
            'GRAIN',   -- 粒
            'BAG',     -- 袋
            'BOTTLE'   -- 瓶
        );
    END IF;
END
$$;


-- ---------------------------------------------------------
-- 3. 药品分类表
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
-- 4. 药箱主表
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS medicine_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 所属用户
    -- 目前用户系统还没建立，所以暂时不添加外键
    user_id UUID NOT NULL,

    -- 药品名称
    -- 注意：不能 UNIQUE，同一种药可能存在多盒/多批次
    name VARCHAR(100) NOT NULL,

    -- 规格，例如：0.25g × 24粒
    specification VARCHAR(100),

    -- 剂型，例如：胶囊、颗粒剂、糖浆
    dosage_form VARCHAR(50),

    -- 当前剩余数量
    quantity INTEGER NOT NULL DEFAULT 1,

    -- 单位：粒 / 袋 / 瓶
    unit medicine_unit NOT NULL,

    -- 有效期
    expiration_date DATE,

    -- 生产厂家
    manufacturer VARCHAR(150),

    -- 功效 / 作用
    efficacy TEXT,

    -- 用法用量
    usage TEXT,

    -- 存放位置
    location VARCHAR(100),

    -- 药品主图
    image_url TEXT,

    -- 用户备注
    note TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- 库存不能小于 0
    CONSTRAINT medicine_items_quantity_check
        CHECK (quantity >= 0)
);


-- ---------------------------------------------------------
-- 5. 药品与分类关联表
-- 一个药品可以属于多个分类
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS medicine_category_relations (
    medicine_item_id UUID NOT NULL,
    category_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (medicine_item_id, category_id),

    CONSTRAINT fk_medicine_category_medicine
        FOREIGN KEY (medicine_item_id)
        REFERENCES medicine_items(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_medicine_category_category
        FOREIGN KEY (category_id)
        REFERENCES medicine_categories(id)
        ON DELETE CASCADE
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

-- 分类关联查询
CREATE INDEX IF NOT EXISTS idx_medicine_category_relations_category
ON medicine_category_relations(category_id);


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