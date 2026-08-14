#!/usr/bin/env node
// eveng2-terminal-textinput — typed text input for Even Terminal (Even G2).
//
// Discovers the even-terminal instance(s) running on this machine through
// their pidfiles (~/.even-terminal/instances/*.json), which contain the HTTP
// port and bearer token, then serves a mobile page and proxies /api/* to the
// selected instance with the Authorization header injected. No patching of
// even-terminal, no dependencies.
//
// Usage:   node server.mjs
// Env:     PORT=8790   BIND_HOST=0.0.0.0 (set your Tailscale IP to restrict
//          access to the tailnet)   EVEN_TERMINAL_PORT=<port> (default
//          instance when several are running)

import { createServer, request } from 'node:http'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, unlinkSync, renameSync, openSync, closeSync } from 'node:fs'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const UPLOAD_DIR = join(tmpdir(), 'eveng2-uploads')
const MAX_UPLOAD = 16 * 1024 * 1024   // 16 MB
// Shared UI state (archives, custom titles, mark-done overrides), persisted
// on the host so every device sees the same thing.
const STATE_FILE = join(homedir(), '.even-terminal', 'textinput-overrides.json')
const MAX_STATE = 1024 * 1024   // 1 MB

const __dirname = dirname(fileURLToPath(import.meta.url))
const INSTANCE_DIR = join(homedir(), '.even-terminal', 'instances')
const PORT = Number(process.env.PORT ?? 8790)
const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0'
// Pin a specific even-terminal instance when several are running
// (otherwise: the most recent one).
const TARGET_PORT = process.env.EVEN_TERMINAL_PORT ? Number(process.env.EVEN_TERMINAL_PORT) : null

// Unlike even-terminal, EPERM counts as dead: even-terminal runs under the
// same user as us, so a PID we are not allowed to signal has necessarily
// been recycled by a system process.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The pid holding the LISTEN socket on `port`, or null if nobody does.
function listeningPid(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    return Number(out.trim().split('\n')[0]) || null
  } catch {
    return null   // lsof exits 1 when nothing listens on the port
  }
}

// Same logic as even-terminal's listLiveInstances() (live pidfiles, most
// recent first), plus one entry per port: a daemon launched while its port
// is already taken keeps running — and keeps its pidfile — without ever
// binding, so several live pidfiles can claim the same port. The pid that
// actually holds the socket wins (restart must kill that one); with no
// listener at all, the most recent pidfile does.
function findInstances() {
  let entries
  try {
    entries = readdirSync(INSTANCE_DIR)
  } catch {
    return []
  }
  const live = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const info = JSON.parse(readFileSync(join(INSTANCE_DIR, name), 'utf8'))
      if (typeof info.pid === 'number' && isPidAlive(info.pid)) live.push(info)
    } catch {
      // unreadable pidfile — skip
    }
  }
  live.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const byPort = new Map()
  const listeners = new Map()
  for (const info of live) {
    if (!byPort.has(info.port)) {
      byPort.set(info.port, info)
      continue
    }
    if (!listeners.has(info.port)) listeners.set(info.port, listeningPid(info.port))
    if (info.pid === listeners.get(info.port)) byPort.set(info.port, info)
  }
  return [...byPort.values()]
}

// portOverride comes from the UI (?_inst=<port>); falls back to
// EVEN_TERMINAL_PORT, then to the most recent instance.
function findInstance(portOverride) {
  const live = findInstances()
  const port = portOverride ?? TARGET_PORT
  if (port) return live.find((i) => i.port === port) ?? null
  return live[0] ?? null
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

// ---- instance restart ------------------------------------------------------
// A wedged even-terminal (or its claude subprocess) can leave every session
// stuck busy with no API-level way out; the only cure is bouncing the whole
// instance. Sessions live on disk and resume on the next prompt, so a
// restart loses nothing but the in-flight turn.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []   // pgrep exits 1 when there are no children
  }
}

// The exact argv the instance was started with, so the respawn keeps every
// flag (--provider, --log-file, …). The bare `node` of the original shell is
// pinned to our own binary since the detached child won't inherit that PATH.
function instanceArgv(pid) {
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
      .trim().split(/\s+/)
    if (!args.some((a) => a.includes('even-terminal'))) return null
    if (basename(args[0]) === 'node') args[0] = process.execPath
    return args
  } catch {
    return null
  }
}

async function killTree(pid, kids) {
  const all = [pid, ...kids]
  const alive = () => all.filter(isPidAlive)
  for (const p of all) { try { process.kill(p, 'SIGTERM') } catch { /* already gone */ } }
  for (let i = 0; i < 20 && alive().length; i++) await sleep(200)
  for (const p of alive()) { try { process.kill(p, 'SIGKILL') } catch { /* already gone */ } }
  for (let i = 0; i < 10 && alive().length; i++) await sleep(200)
  return alive().length === 0
}

async function restartInstance(port) {
  const inst = findInstances().find((i) => i.port === port)
  if (!inst) return { status: 404, body: { error: `No live even-terminal instance on port ${port}` } }

  // Capture argv and children before the kill — both need a live process.
  const argv = instanceArgv(inst.pid) ??
    [process.execPath, join(dirname(process.execPath), 'even-terminal'),
      '-d', inst.cwd, '-p', String(inst.port), '-t', inst.token]
  const kids = childPids(inst.pid)

  if (!await killTree(inst.pid, kids)) {
    return { status: 500, body: { error: `Could not kill pid ${inst.pid} — restart it manually` } }
  }

  // Detached respawn, logs to a file since the original terminal is lost.
  const logPath = join(homedir(), '.even-terminal', `textinput-restart-${port}.log`)
  let fd
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    fd = openSync(logPath, 'a')
    const child = spawn(argv[0], argv.slice(1), {
      cwd: inst.cwd, detached: true, stdio: ['ignore', fd, fd],
    })
    child.unref()
  } catch (err) {
    return { status: 500, body: { error: `Respawn failed: ${err.message}` } }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }

  // Up = the new pidfile shows a live instance on the same port.
  for (let i = 0; i < 50; i++) {
    await sleep(200)
    const fresh = findInstances().find((i2) => i2.port === port && i2.pid !== inst.pid)
    if (fresh) return { status: 200, body: { ok: true, pid: fresh.pid, log: logPath } }
  }
  return { status: 504, body: { error: `even-terminal did not come back on port ${port} — see ${logPath}` } }
}

const server = createServer((req, res) => {
  const url = req.url ?? '/'

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = readFileSync(join(__dirname, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(500)
      res.end('index.html not found')
    }
    return
  }

  // Live instances for the UI (tokens stripped)
  if (req.method === 'GET' && url === '/companion/instances') {
    sendJson(res, 200, findInstances().map((i) => ({
      pid: i.pid, port: i.port, cwd: i.cwd, startedAt: i.startedAt,
    })))
    return
  }

  // Shared UI state: full-state read/write, last-write-wins — fine for a
  // single user across a few devices.
  if (req.method === 'GET' && url === '/companion/overrides') {
    try {
      sendJson(res, 200, JSON.parse(readFileSync(STATE_FILE, 'utf8')))
    } catch {
      sendJson(res, 200, {})   // no state saved yet
    }
    return
  }

  if ((req.method === 'PUT' || req.method === 'POST') && url === '/companion/overrides') {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_STATE) { sendJson(res, 413, { error: 'State too large' }); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      if (res.headersSent) return
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const pick = (k) => (body && typeof body[k] === 'object' && body[k]) || {}
        const state = { done: pick('done'), archived: pick('archived'), titles: pick('titles') }
        mkdirSync(dirname(STATE_FILE), { recursive: true })
        // Atomic write so a crash mid-write can't corrupt the state file.
        writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state))
        renameSync(STATE_FILE + '.tmp', STATE_FILE)
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 400, { error: err.message })
      }
    })
    return
  }

  // Bounce a stuck even-terminal instance: kill it (and its claude
  // subprocesses) then respawn it detached with the same command line.
  if (req.method === 'POST' && url === '/companion/restart-instance') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      let port
      try {
        port = Number(JSON.parse(Buffer.concat(chunks).toString('utf8')).port)
      } catch { /* fall through to the check below */ }
      if (!Number.isInteger(port)) { sendJson(res, 400, { error: 'Expected { port }' }); return }
      try {
        const { status, body } = await restartInstance(port)
        sendJson(res, status, body)
      } catch (err) {
        sendJson(res, 500, { error: err.message })
      }
    })
    return
  }

  // Receive a screenshot or zip as a data URL, write it to disk, return its
  // absolute path so the client can reference it in a prompt (Claude Code
  // reads/unzips it itself). even-terminal's API stays text-only.
  if (req.method === 'POST' && url === '/companion/upload') {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_UPLOAD) { sendJson(res, 413, { error: 'File too large (max 16 MB)' }); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      if (res.headersSent) return
      try {
        const { dataUrl, name } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s.exec(dataUrl || '')
        if (!m) { sendJson(res, 400, { error: 'Expected a base64 data URL' }); return }
        const MIME_EXT = {
          'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
          'image/webp': 'webp', 'image/gif': 'gif',
          'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
        }
        // Mobile pickers often report octet-stream for zips — trust the name.
        const ext = MIME_EXT[m[1]] || (/\.zip$/i.test(name || '') ? 'zip' : null)
        if (!ext) { sendJson(res, 400, { error: 'Unsupported file type (images and zip only)' }); return }
        mkdirSync(UPLOAD_DIR, { recursive: true })
        // Best-effort GC: drop uploads older than a day.
        try {
          for (const f of readdirSync(UPLOAD_DIR)) {
            const p = join(UPLOAD_DIR, f)
            if (Date.now() - statSync(p).mtimeMs > 86_400_000) unlinkSync(p)
          }
        } catch { /* ignore */ }
        const fname = `${Date.now()}-${Math.round(Math.random() * 1e9).toString(36)}.${ext}`
        const path = join(UPLOAD_DIR, fname)
        writeFileSync(path, Buffer.from(m[2], 'base64'))
        sendJson(res, 200, { path })
      } catch (err) {
        sendJson(res, 400, { error: err.message })
      }
    })
    return
  }

  if (url.startsWith('/api/')) {
    // The UI targets a specific instance via ?_inst=<port> (a query param
    // unknown to even-terminal, hence harmless once forwarded)
    const m = url.match(/[?&]_inst=(\d+)/)
    const inst = findInstance(m ? Number(m[1]) : undefined)
    if (!inst) {
      sendJson(res, 502, { error: 'No even-terminal instance running — start `even-terminal` on the host first.' })
      return
    }
    const upstream = request(
      {
        host: '127.0.0.1',
        port: inst.port,
        path: url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${inst.port}`,
          authorization: `Bearer ${inst.token}`,
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `even-terminal unreachable: ${err.message}` })
      } else {
        res.end()
      }
    })
    req.pipe(upstream)
    // Tear down the upstream SSE stream when the phone disconnects
    res.on('close', () => upstream.destroy())
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, BIND_HOST, () => {
  const live = findInstances()
  console.log('eveng2-terminal-textinput — typed text input for Even Terminal')
  if (live.length === 0) {
    console.log('WARNING: no even-terminal instance detected (start `even-terminal`, then reload the page)')
  } else {
    for (const i of live) console.log(`even-terminal instance: pid=${i.pid} port=${i.port} cwd=${i.cwd}`)
  }
  console.log('\nOpen on your phone:')
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const tag = a.address.startsWith('100.') ? '  ← Tailscale' : ''
      console.log(`  http://${a.address}:${PORT}/   (${name})${tag}`)
    }
  }
})
