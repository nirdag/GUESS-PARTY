import { spawn } from 'node:child_process'
import path from 'node:path'

export const WEB_PORT = Number(process.env.SCENARIO_WEB_PORT || 5273)
export const API_PORT = Number(process.env.SCENARIO_API_PORT || 8181)
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`
export const API_URL = `http://127.0.0.1:${API_PORT}`
const root = process.cwd()

const children = []

async function isUp(url) {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

async function waitUntilUp(url, label) {
  for (let i = 0; i < 120; i += 1) {
    if (await isUp(url)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} did not start at ${url}`)
}

function start(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' })
  children.push(child)
}

// Separate ports and data dir from `npm run dev` / e2e so scenarios never touch real data.
export async function ensureServers() {
  if (!(await isUp(`${API_URL}/health`))) {
    start(['server.js'], {
      NODE_ENV: 'development',
      APP_ORIGIN: WEB_URL,
      E2E_TEST_MODE: 'true',
      GUESS_PARTY_DATA_DIR: path.join(root, '.scenario-data'),
      PORT: String(API_PORT),
    })
  }
  if (!(await isUp(`${WEB_URL}/`))) {
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'], {
      VITE_API_PORT: String(API_PORT),
    })
  }
  await Promise.all([waitUntilUp(`${API_URL}/health`, 'API server'), waitUntilUp(`${WEB_URL}/`, 'Vite dev server')])
}

export function stopServers() {
  for (const child of children) {
    child.kill()
  }
  children.length = 0
}
