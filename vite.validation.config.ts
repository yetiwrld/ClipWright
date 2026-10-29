import { defineConfig } from 'vite';

export default defineConfig({
  configFile: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/lib/exportValidationMedia.ts',
      formats: ['es'],
      fileName: () => 'export-validation-media.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
