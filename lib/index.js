// dsh-ui-liteglass — host half.
//
// Responsibilities:
//   * persist plugin config (wallpaper ref, opacity/blur, glass, accent)
//     as a small JSON document under $DSH_HOME/ui-liteglass/
//   * accept background image uploads and store them under
//     $DSH_HOME/ui-liteglass/backgrounds/, returning a server-relative URL
//   * serve stored background images
//   * expose the authoritative native theme preference (read from the DSH
//     settings descriptors) for callers that need to know the native color
//     mode; the plugin itself never changes it.
//
// Uses node:fs directly (no `fs` service dependency). Serves from a shared
// server directory, so any client device that reaches the DSH host sees the
// same wallpaper.
//
// Security / lifecycle contract (DSH 0.2.1):
//   * Host authentication is per-route: only the index and /api are covered by
//     the harness gate, so every route here authenticates itself through the
//     `connection` service and rejects browser writes that fail the same-origin
//     check.
//   * Every route is registered inside `ctx.effect`, so unloading the plugin
//     releases it and a live patch reload can register again instead of
//     tripping webserver's duplicate-route guard.

import { promises as fsp } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DATA_SUBDIR = 'ui-liteglass'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
// Control grids (mirrored in lib/client.js). Opacity moves in 10% steps, blur
// in 5px steps up to 30px; the config is snapped to the same grid on write so
// the panel can always represent the value it shows.
const OPACITY_STEP = 0.1
const BLUR_STEP = 5
const BLUR_MAX = 30
// Unreferenced background files older than this are pruned on a successful
// upload, so the directory cannot grow without bound. Recent files are kept
// because a client may still be saving a config that points at them.
const PRUNE_MIN_AGE_MS = 60 * 60 * 1000
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
// Content types that are safe to serve back as an image body.
const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
const DEFAULT_CONFIG = {
  background: 'off',
  backgroundImage: '',
  backgroundOpacity: 0.4,
  backgroundBlur: 0,
  panelOpacity: 1, // 1 = fully opaque = native appearance (plugin off by default)
  panelBlur: 0,
  accentColor: '',
  // Opt-in: paint primary buttons with the accent color. Off by default so the
  // DSH 0.2.x monochrome primary button is left alone.
  accentButtons: false
}

function dataDir() {
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  return join(home, DATA_SUBDIR)
}

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Clamp onto a fixed grid (10% opacity, 5px blur). */
function snapNum(value, min, max, step, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const snapped = Math.round(n / step) * step
  // 3 decimals: 3 * 0.1 is 0.30000000000000004 in binary floating point.
  return Math.round(Math.min(max, Math.max(min, snapped)) * 1000) / 1000
}

function sanitizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    background: ['off', 'url', 'local'].includes(c.background) ? c.background : 'off',
    backgroundImage: typeof c.backgroundImage === 'string' ? String(c.backgroundImage).slice(0, 4096) : '',
    backgroundOpacity: snapNum(c.backgroundOpacity, 0, 1, OPACITY_STEP, 0.4),
    backgroundBlur: snapNum(c.backgroundBlur, 0, BLUR_MAX, BLUR_STEP, 0),
    panelOpacity: snapNum(c.panelOpacity, OPACITY_STEP, 1, OPACITY_STEP, 1),
    panelBlur: snapNum(c.panelBlur, 0, BLUR_MAX, BLUR_STEP, 0),
    accentColor: /^#[0-9a-fA-F]{3,8}$/.test(c.accentColor) ? String(c.accentColor) : '',
    accentButtons: c.accentButtons === true
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Read the stored config document, keeping the three states the client must not
 * conflate apart:
 *   * absent      — a fresh install; `{ config: null }`.
 *   * unreadable  — the file exists but is not a JSON object; `{ unreadable: true }`.
 *                   Refused rather than reported as empty, so defaults are never
 *                   written over a file the user could still repair by hand.
 *   * readable    — `{ config }`.
 * @param file - absolute path of config.json.
 * @returns the discriminator above; non-ENOENT IO errors still throw.
 */
async function readConfigDocument(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { config: null }
    throw e
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { config: parsed }
  } catch { /* malformed: falls through to unreadable */ }
  return { unreadable: true }
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
  return CONTENT_TYPES[extname(name).toLowerCase()] || 'application/octet-stream'
}

/**
 * Sniff an image container from its magic bytes.
 * @param {Buffer} buf - candidate image body.
 * @returns {string|null} the matched extension, or null when the bytes are not
 * a supported image (a lying content type must not become a stored file).
 */
function sniffImageExt(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return '.gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  return null
}

/** Distinguish an over-limit body from a transport failure. */
class BodyTooLarge extends Error {}

/**
 * Read a request body with a hard ceiling enforced WHILE streaming: an
 * oversized client is rejected before its bytes are buffered, so the memory
 * cost is bounded by `limit` rather than by what the caller sends.
 * @param {import('node:http').IncomingMessage} req - request stream.
 * @param {number} limit - maximum accepted byte count.
 * @returns {Promise<Buffer>} the complete body.
 * @throws {BodyTooLarge} when the body exceeds `limit`.
 */
async function readLimitedBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limit) throw new BodyTooLarge('payload too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function headerValue(req, name) {
  const raw = req.headers ? req.headers[name] : undefined
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * Reject a browser write whose Origin names a different host. Non-browser
 * callers send no Origin and are left to the authentication check.
 */
function sameOrigin(req) {
  const origin = headerValue(req, 'origin')
  if (origin === undefined || origin === '') return true
  const host = headerValue(req, 'host')
  if (host === undefined || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(obj))
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

/**
 * Remove background files that nothing references any more.
 * The file named by a fresh config and anything newer than `PRUNE_MIN_AGE_MS`
 * survive, so a client that is still saving its config cannot lose its image.
 */
async function pruneBackgrounds(dir, configFile, keepName) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const cfg = await readJson(configFile, null)
  const referenced = cfg && typeof cfg.backgroundImage === 'string'
    ? String(cfg.backgroundImage).split('/').pop()
    : ''
  const cutoff = Date.now() - PRUNE_MIN_AGE_MS
  for (const name of names) {
    if (name === keepName || name === referenced) continue
    if (!SAFE_BACKGROUND_NAME.test(name)) continue
    try {
      const stat = await fsp.stat(join(dir, name))
      if (stat.mtimeMs > cutoff) continue
      await fsp.unlink(join(dir, name))
    } catch {
      // A file that vanished or cannot be read is simply left alone.
    }
  }
}

export default {
  inject: ['webServer', 'settings', 'connection'],
  apply(ctx) {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return

    const dir = dataDir()
    const configFile = join(dir, 'config.json')
    const backgroundsDir = join(dir, 'backgrounds')

    const settings = ctx.get('settings')
    const connection = ctx.get('connection')

    /**
     * Read the native color-mode preference from the settings descriptors.
     * DSH 0.2.x exposes `settings.describe()` (no `settings.get(ns)`), so the
     * section is located by its namespace instead of read as a document.
     */
    const nativePreference = () => {
      try {
        if (!settings || typeof settings.describe !== 'function') return 'system'
        const rows = settings.describe()
        const row = Array.isArray(rows) ? rows.find((r) => r && r.ns === 'ui-theme') : undefined
        const preference = row && row.value ? row.value.preference : undefined
        return typeof preference === 'string' && preference.length > 0 ? preference : 'system'
      } catch {
        return 'system'
      }
    }

    /**
     * Admission for one request, delegated to the harness connection service.
     *
     * The 0.2.x host service exposes `requestRejection` (the Host/Origin fence
     * plus browser-session verification) and `admit`; the `isAuthenticated`
     * method lives on the connection's internal BrowserAuth object, not on the
     * service, so testing for it here made every route answer 401 — which read
     * like "no saved config" on the client and silently disabled persistence.
     *
     * @returns undefined when admitted, otherwise the HTTP status to refuse with.
     */
    const admissionStatus = (req) => {
      if (!connection) return 401
      try {
        if (typeof connection.requestRejection === 'function') {
          const rejection = connection.requestRejection(req)
          if (rejection === undefined) return undefined
          return rejection === 403 ? 403 : 401
        }
        if (typeof connection.admit === 'function') {
          const admission = connection.admit(req)
          if (admission && typeof admission === 'object' && !('rejection' in admission)) return undefined
          return admission && admission.rejection === 403 ? 403 : 401
        }
      } catch {
        return 401
      }
      return 401
    }

    /** Register one route on the plugin fiber so unload releases it. */
    const route = (definition, label) => {
      if (typeof ctx.effect === 'function') ctx.effect(() => webServer.register(definition), label)
      else webServer.register(definition)
    }

    route({
      kind: 'exact',
      path: '/ui-liteglass/config',
      handler: async (req, res) => {
        const refused = admissionStatus(req)
        if (refused !== undefined) return sendJson(res, { ok: false, error: refused === 403 ? 'forbidden' : 'unauthorized' }, refused)
        try {
          if (req.method === 'GET') {
            const state = await readConfigDocument(configFile)
            if (state.unreadable) {
              // Never let an unreadable document look like an empty one: the
              // client would normalise defaults and write them back over it.
              return sendJson(res, { ok: false, error: 'config-unreadable' }, 500)
            }
            sendJson(res, { ok: true, config: state.config })
          } else if (req.method === 'POST') {
            if (!sameOrigin(req)) return sendJson(res, { ok: false, error: 'cross-origin write rejected' }, 403)
            // A JSON content type forces a CORS preflight for cross-origin
            // callers, so a form/text-plain post cannot rewrite the config.
            const contentType = String(headerValue(req, 'content-type') || '').toLowerCase().split(';')[0].trim()
            if (contentType !== 'application/json') return sendJson(res, { ok: false, error: 'unsupported content type' }, 415)
            let buf
            try {
              buf = await readLimitedBody(req, 64 * 1024)
            } catch (e) {
              if (e instanceof BodyTooLarge) return sendJson(res, { ok: false, error: 'config too large' }, 413)
              throw e
            }
            let next
            try {
              next = JSON.parse(buf.toString('utf8'))
            } catch {
              return sendJson(res, { ok: false, error: 'bad json' })
            }
            const clean = sanitizeConfig(next)
            await writeJson(configFile, clean)
            sendJson(res, { ok: true, config: clean })
          } else {
            sendJson(res, { ok: false, error: 'method not allowed' }, 405)
          }
        } catch (e) {
          sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    }, 'ui-liteglass: /ui-liteglass/config')

    route({
      kind: 'exact',
      path: '/ui-liteglass/state',
      handler: async (req, res) => {
        const refused = admissionStatus(req)
        if (refused !== undefined) return sendJson(res, { ok: false, error: refused === 403 ? 'forbidden' : 'unauthorized' }, refused)
        sendJson(res, { ok: true, nativePreference: nativePreference() })
      }
    }, 'ui-liteglass: /ui-liteglass/state')

    route({
      kind: 'exact',
      path: '/ui-liteglass/background',
      handler: async (req, res) => {
        const refused = admissionStatus(req)
        if (refused !== undefined) return sendJson(res, { ok: false, error: refused === 403 ? 'forbidden' : 'unauthorized' }, refused)
        if (!sameOrigin(req)) return sendJson(res, { ok: false, error: 'cross-origin write rejected' }, 403)
        try {
          const ext = extFromContentType(headerValue(req, 'content-type'))
          if (!ext) return sendJson(res, { ok: false, error: 'unsupported content type' }, 415)
          let buf
          try {
            buf = await readLimitedBody(req, MAX_IMAGE_BYTES)
          } catch (e) {
            if (e instanceof BodyTooLarge) return sendJson(res, { ok: false, error: 'image too large' }, 413)
            throw e
          }
          if (buf.length === 0) return sendJson(res, { ok: false, error: 'empty body' })
          // The declared type must agree with the bytes: a content type alone
          // is not evidence that the body is an image.
          const sniffed = sniffImageExt(buf)
          if (sniffed === null) return sendJson(res, { ok: false, error: 'body is not a supported image' }, 415)
          if (sniffed !== ext) return sendJson(res, { ok: false, error: 'content type does not match image bytes' }, 415)
          const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)
          const name = `${id}${ext}`
          const file = join(backgroundsDir, name)
          await fsp.mkdir(backgroundsDir, { recursive: true })
          await fsp.writeFile(file, buf)
          await pruneBackgrounds(backgroundsDir, configFile, name)
          sendJson(res, { ok: true, url: `/ui-liteglass/backgrounds/${name}` })
        } catch (e) {
          sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    }, 'ui-liteglass: /ui-liteglass/background')

    // GET /ui-liteglass/backgrounds/* — serve stored background images.
    // NOTE: register the prefix WITHOUT a trailing slash — the host webServer
    // matches prefix routes via `pathname.startsWith(prefix + "/")`, so a
    // trailing slash would double into "//" and never match.
    // The name is strictly validated (16-hex id + whitelisted ext) BEFORE any
    // path join, so traversal / bogus names are rejected (400) and a missing
    // well-formed file is a plain 404.
    route({
      kind: 'prefix',
      path: '/ui-liteglass/backgrounds',
      handler: async (req, res) => {
        const refused = admissionStatus(req)
        if (refused !== undefined) return sendText(res, refused, refused === 403 ? 'forbidden' : 'unauthorized')
        try {
          const rawName = decodeURIComponent(String(req.url).split('?')[0]).split('/').pop() || ''
          if (!SAFE_BACKGROUND_NAME.test(rawName)) {
            sendText(res, 400, 'bad request')
            return
          }
          const data = await fsp.readFile(join(backgroundsDir, rawName)).catch(() => null)
          if (data === null) {
            sendText(res, 404, 'not found')
            return
          }
          res.writeHead(200, {
            'Content-Type': contentTypeFor(rawName),
            // Served to authenticated sessions only, so the shared proxy cache
            // must not keep a copy.
            'Cache-Control': 'private, max-age=31536000, immutable'
          })
          res.end(data)
        } catch {
          if (!res.headersSent) sendText(res, 500, 'internal error')
          else res.end()
        }
      }
    }, 'ui-liteglass: /ui-liteglass/backgrounds')
  }
}
