import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  base: '/chidiya-ud/',
  build: mode === 'pages' ? undefined : {
    rollupOptions: {
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        leaderboard: new URL('./leaderboard/index.html', import.meta.url).pathname,
        admin: new URL('./admin/index.html', import.meta.url).pathname,
      },
    },
  },
  server: {
    proxy: {
      '/chidiya-ud/api': {
        target: process.env.CHIDIYA_API_TARGET ?? 'http://127.0.0.1:8082',
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (request.headers.host) proxyRequest.setHeader('Host', request.headers.host)
          })
        },
      },
    },
  },
}))
