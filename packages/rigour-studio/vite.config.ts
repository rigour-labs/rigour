import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = process.env.RIGOUR_API_PORT || '3001'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        port: 3000,
        proxy: {
            '/api': {
                target: `http://127.0.0.1:${apiPort}`,
                changeOrigin: true,
            },
        },
    },
})
