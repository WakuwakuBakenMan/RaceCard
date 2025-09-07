import react from "@astrojs/react";
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [react()],
  output: 'static',
  site: 'https://your-user.github.io/RaceCard/',
  base: '/RaceCard',
  build: {
    format: 'directory'
  },
  vite: {
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    }
  }
});
