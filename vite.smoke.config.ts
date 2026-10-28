import { defineConfig } from 'vite';

export default defineConfig({
  configFile: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/lib/deterministicWebmSmoke.ts',
      formats: ['es'],
      fileName: () => 'export-smoke.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
