import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
});
