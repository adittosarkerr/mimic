import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind all interfaces — IPv6-only default here has refused IPv4 localhost
    // connections (the browser/extension resolve "localhost" to 127.0.0.1).
    host: true,
    strictPort: true,
  },
})
