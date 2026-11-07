import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { fileParallelism: false, env: { DATABASE_URL: 'postgres://loryand:loryand@localhost:5432/loryand_test', SESSION_SECRET: 'test-secret' } },
});
