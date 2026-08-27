// dsh-ui-liteglass — host half (minimal).
//
// Responsibilities:
//   * persist plugin config (wallpaper ref, opacity/blur, glass, accent)
//     as a small JSON document under $DSH_HOME/ui-liteglass/
//   * accept background image uploads and store them under
//     $DSH_HOME/ui-liteglass/backgrounds/, returning a server-relative URL
//   * serve stored background images
//   * expose the authoritative native theme preference (read from the DSH
//     settings document) for callers that need to know the native color mode;
//     the plugin itself never changes it.
//
// Uses node:fs directly (no `fs` service dependency). Serves from a shared
// server directory, so any client device that reaches the DSH host sees the
// same wallpaper.

import { promises as fsp } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DATA_SUBDIR = 'ui-liteglass'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
// Whitelist of accepted image content types (upload) → stored extension.
const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}
// Stored background filenames we ever produce and will serve. Anything else
// (path traversal, unusual names) is rejected before touching the filesystem.
const SAFE_BACKGROUND_NAME = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/
const DEFAULT_CONFIG = {
  background: 'off',
  backgroundImage: '',
  backgroundOpacity: 0.35,
  backgroundBlur: 0,
  panelOpacity: 1, // 1 = fully opaque = native appearance (plugin off by default)
  panelBlur: 0,
  accentColor: ''
}

function dataDir() {
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  return join(home, DATA_SUBDIR)
}

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function sanitizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    background: ['off', 'url', 'local'].includes(c.background) ? c.background : 'off',
    backgroundImage: typeof c.backgroundImage === 'string' ? String(c.backgroundImage).slice(0, 4096) : '',
    backgroundOpacity: clampNum(c.backgroundOpacity, 0, 1, 0.35),
    backgroundBlur: clampNum(c.backgroundBlur, 0, 40, 0),
    panelOpacity: clampNum(c.panelOpacity, 0, 1, 1),
    panelBlur: clampNum(c.panelBlur, 0, 40, 0),
    accentColor: /^#[0-9a-fA-F]{3,8}$/.test(c.accentColor) ? String(c.accentColor) : ''
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

function extFromContentType(ct) {
  const s = String(ct || '').toLowerCase().split(';')[0].trim()
  return IMAGE_TYPES[s] || null
}

function contentTypeFor(name) {
  const e = extname(name).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.webp') return 'image/webp'
  if (e === '.gif') return 'image/gif'
  if (e === '.svg') return 'image/svg+xml'
  return 'image/jpeg'
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

export default {
  inject: ['webServer', 'settings'],
  apply(ctx) {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return

    const dir = dataDir()
    const configFile = join(dir, 'config.json')
    const backgroundsDir = join(dir, 'backgrounds')

    const settings = ctx.get('settings')
    const nativePreference = () => {
      try {
        const section = settings && typeof settings.get === 'function' ? settings.get('ui-theme') : undefined
        return section && section.preference ? String(section.preference) : 'system'
      } catch {
        return 'system'
      }
    }

    // GET/POST /ui-liteglass/config
    webServer.register({
      kind: 'exact',
      path: '/ui-liteglass/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, { ok: true, config: await readJson(configFile, null) })
          } else if (req.method === 'POST') {
            const body = await readBody(req)
            let next
            try {
              next = JSON.parse(body.toString('utf8'))
            } catch {
              return sendJson(res, { ok: false, error: 'bad json' })
            }
            const clean = sanitizeConfig(next)
            await writeJson(configFile, clean)
            sendJson(res, { ok: true, config: clean })
          } else {
            sendJson(res, { ok: false, error: 'method not allowed' })
          }
        } catch (e) {
          sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    })

    // GET /ui-liteglass/state — authoritative native theme preference
    webServer.register({
      kind: 'exact',
      path: '/ui-liteglass/state',
      handler: async (_req, res) => {
        sendJson(res, { ok: true, nativePreference: nativePreference() })
      }
    })

    // POST /ui-liteglass/background — upload an image (raw body)
    webServer.register({
      kind: 'exact',
      path: '/ui-liteglass/background',
      handler: async (req, res) => {
        try {
          const ext = extFromContentType(req.headers['content-type'])
          if (!ext) return sendJson(res, { ok: false, error: 'unsupported content type' })
          const buf = await readBody(req)
          if (buf.length === 0) return sendJson(res, { ok: false, error: 'empty body' })
          if (buf.length > MAX_IMAGE_BYTES) return sendJson(res, { ok: false, error: 'image too large' })
          const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)
          const file = join(backgroundsDir, `${id}${ext}`)
          await fsp.mkdir(backgroundsDir, { recursive: true })
          await fsp.writeFile(file, buf)
          sendJson(res, { ok: true, url: `/ui-liteglass/backgrounds/${id}${ext}` })
        } catch (e) {
          sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    })

    // GET /ui-liteglass/backgrounds/* — serve stored background images.
    // NOTE: register the prefix WITHOUT a trailing slash — the host webServer
    // matches prefix routes via `pathname.startsWith(prefix + "/")`, so a
    // trailing slash would double into "//" and never match.
    // The name is strictly validated (16-hex id + whitelisted ext) BEFORE any
    // path join, so traversal / bogus names are rejected (400) and a missing
    // well-formed file is a plain 404.
    webServer.register({
      kind: 'prefix',
      path: '/ui-liteglass/backgrounds',
      handler: async (req, res) => {
        try {
          const rawName = decodeURIComponent(String(req.url).split('?')[0]).split('/').pop() || ''
          if (!SAFE_BACKGROUND_NAME.test(rawName)) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('bad request')
            return
          }
          const data = await fsp.readFile(join(backgroundsDir, rawName)).catch(() => null)
          if (data === null) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          res.writeHead(200, { 'Content-Type': contentTypeFor(rawName), 'Cache-Control': 'public, max-age=31536000, immutable' })
          res.end(data)
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('internal error')
          } else {
            res.end()
          }
        }
      }
    })
  }
}
