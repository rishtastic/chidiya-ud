import { defineConfig } from 'vite'

export default defineConfig({
  base: '/chidiya-ud/',
  server: {
    proxy: {
      '/chidiya-ud/api': 'http://127.0.0.1:8082',
    },
  },
})
