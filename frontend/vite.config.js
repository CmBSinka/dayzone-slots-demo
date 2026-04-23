import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Basic Vite config for the standalone React frontend.
export default defineConfig({
  plugins: [react()],
})
