import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // PrismaService 在用例中被内存实现替换，这里只需满足启动时的环境变量校验
    env: {
      DATABASE_URL: 'postgresql://e2e:e2e@localhost:5432/e2e',
      DEV_USER_ID: '00000000-0000-4000-8000-000000000001',
    },
  },
});
