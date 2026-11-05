/*
  - 新增用户字典表 user_dictionaries：每个用户至多一条记录。
  - categories / efficacies / symptoms 使用 TEXT[]，默认空数组。
*/

-- CreateTable
CREATE TABLE "user_dictionaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "efficacies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "symptoms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_dictionaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_dictionaries_user_id_key" ON "user_dictionaries"("user_id");

-- AddForeignKey
ALTER TABLE "user_dictionaries" ADD CONSTRAINT "user_dictionaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- UpdatedAtTrigger
CREATE TRIGGER update_user_dictionaries_updated_at
BEFORE UPDATE ON user_dictionaries
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- AddComment
COMMENT ON TABLE user_dictionaries IS '用户字典表，每个用户一条记录，保存药品大类、功效、症状等标签';

COMMENT ON COLUMN user_dictionaries.id IS '主键 ID';
COMMENT ON COLUMN user_dictionaries.user_id IS '所属用户 ID，关联 users.id，唯一';
COMMENT ON COLUMN user_dictionaries.categories IS '药品大类标签数组，例如：{感冒发烧,消炎抗菌}';
COMMENT ON COLUMN user_dictionaries.efficacies IS '核心功效标签数组，例如：{退烧,止痛}';
COMMENT ON COLUMN user_dictionaries.symptoms IS '症状标签数组，例如：{头痛,发热}';
COMMENT ON COLUMN user_dictionaries.created_at IS '创建时间';
COMMENT ON COLUMN user_dictionaries.updated_at IS '更新时间';
