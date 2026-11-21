import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { execSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { playerOrigin, playerScheme } from './src/shared/contracts'

function currentCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'dev'
  }
}

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const define = {
  __BUILD_COMMIT__: JSON.stringify(currentCommit()),
  // app.getVersion() reports Electron's own version in a dev launch.
  __BUILD_VERSION__: JSON.stringify(packageVersion()),
}

export default defineConfig({
  main: {
    define,
    plugins: [{
      name: 'mustplay-window-icon',
      writeBundle({ dir }) {
        copyFileSync('src/assets/mustplay.ico', resolve(dir!, 'mustplay.ico'))
      },
    }],
  },
  preload: {
    define,
    build: {
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    define,
    server: { host: '127.0.0.1' },
    build: { assetsInlineLimit: 0 },
    plugins: [react(), tailwindcss(), {
      name: 'player-content-security-policy',
      transformIndexHtml(_html, { server }) {
        const policy = [
          "default-src 'none'",
          `script-src 'self'${server ? " 'unsafe-inline'" : ''}`,
          `style-src 'self'${server ? " 'unsafe-inline'" : ''}`,
          `media-src ${server ? `${playerScheme}:` : "'self'"}`,
          `img-src ${server ? "'self' " + playerOrigin : "'self'"}`,
          `connect-src 'self'${server ? ' ws://127.0.0.1:*' : ''}`,
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ')
        return [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        }]
      },
    }],
  },
})
