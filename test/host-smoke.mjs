// dsh-ui-liteglass — host-side end-to-end smoke test.
//
// Runs ONLY the plugin's own host logic against a THROWAWAY DSH_HOME (a temp
// dir under os.tmpdir()). It does not touch /root/.dsh, does not install the
// plugin, and does not start/restart any server. All temp data is removed in
// the finally block.
//
// The plugin's apply() needs `webServer.register`, `ctx.effect`, and the
// `connection` / `settings` services; the mocks below mirror the DSH 0.2.x
// contracts those methods carry:
//   * webserver matches exact first, then the longest prefix via
//     `pathname.startsWith(prefix + "/")`;
//   * `connection.isAuthenticated(request)` is the per-route gate (the harness
//     itself only authenticates the index and /api);
//   * `settings.describe()` returns descriptors keyed by namespace.

import { mkdtemp, readFile, rm, access, mkdir, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const pkgRoot = new URL('..', import.meta.url).pathname

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

function makeReq(method, url, headers = {}, body = null) {
  const req = new Readable({ read() {} })
  req.method = method
  req.url = url
  // node:http lower-cases incoming header names; mimic that so handler reads
  // like req.headers['content-type'] work identically to the real server.
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  if (body) req.push(body)
  req.push(null)
  return req
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    rawBody: null,
    _headSent: false,
    writeHead(code, h) { this.statusCode = code; if (h) this.headers = Object.assign({}, h); this._headSent = true },
    end(chunk) {
      if (Buffer.isBuffer(chunk)) { this.rawBody = chunk; this.body = chunk.toString('utf8') }
      else if (chunk !== undefined) { this.body = String(chunk) }
    }
  }
}

function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      const entry = { route, disposed: false }
      routes.push(entry)
      return () => {
        entry.disposed = true
        const at = routes.indexOf(entry)
        if (at !== -1) routes.splice(at, 1)
      }
    },
    active() { return routes.map((e) => e.route) },
    async dispatch(method, url, headers, body) {
      const path = String(url).split('?')[0]
      const active = routes.map((e) => e.route)
      const exact = active.find((r) => r.kind === 'exact' && r.path === path)
      if (exact) return await run(exact)
      let best
      for (const r of active) {
        if (r.kind !== 'prefix') continue
        if (path !== r.path && !path.startsWith(r.path + '/')) continue
        if (best === void 0 || r.path.length > best.path.length) best = r
      }
      if (!best) throw new Error('no matching route: ' + path)
      return await run(best)

      async function run(route) {
        const req = makeReq(method, url, headers, body)
        const res = makeRes()
        try { await route.handler(req, res) } catch (e) {
          if (!res._headSent) { res.writeHead(500); res.end('handler-error:' + (e && e.message)) }
        }
        return res
      }
    }
  }
}

function makeCtx(services) {
  const disposers = []
  return {
    get: (name) => services[name],
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    dispose() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try { dispose() } catch { /* ignore */ }
      }
    }
  }
}

const AUTH = { cookie: 'session=test' }
const ANON = { 'x-test-anon': '1' }
// A minimal PNG-signature body: enough for the magic-byte sniff.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('liteglass-test')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not-a-png')])

const tmpHome = await mkdtemp(join(tmpdir(), 'dsh-ui-liteglass-test-'))
process.env.DSH_HOME = tmpHome

const { default: plugin } = await import(join(pkgRoot, 'lib/index.js'))

const dataDir = join(tmpHome, 'ui-liteglass')
const backgroundsDir = join(dataDir, 'backgrounds')
const configFile = join(dataDir, 'config.json')

function makeServices(overrides = {}) {
  const webServer = makeWebServer()
  const connection = {
    isAuthenticated(req) {
      if (req.headers['x-test-anon'] === '1') return false
      return req.headers.cookie === AUTH.cookie
    }
  }
  const settings = { describe: () => [{ ns: 'ui-theme', value: { preference: 'dark' } }] }
  return { webServer, connection, settings, ...overrides }
}

let failed = false
try {
  console.log('\n== host apply (register routes on the fiber) ==')
  const services = makeServices()
  const ctx = makeCtx(services)
  plugin.apply(ctx)
  check('four routes registered', services.webServer.active().length === 4)
  check('plugin declares connection + settings + webServer',
    ['webServer', 'settings', 'connection'].every((name) => plugin.inject.includes(name)))

  console.log('\n== authentication gate (DSH 0.2.x authenticates per route) ==')
  let res = await services.webServer.dispatch('GET', '/ui-liteglass/config', ANON)
  check('anonymous config GET → 401', res.statusCode === 401)
  res = await services.webServer.dispatch('GET', '/ui-liteglass/state', ANON)
  check('anonymous state GET → 401', res.statusCode === 401)
  res = await services.webServer.dispatch('POST', '/ui-liteglass/background', ANON, PNG)
  check('anonymous upload → 401', res.statusCode === 401)
  res = await services.webServer.dispatch('GET', '/ui-liteglass/backgrounds/' + 'a'.repeat(16) + '.png', ANON)
  check('anonymous background GET → 401', res.statusCode === 401)

  console.log('\n== config read/write (full normalization) ==')
  res = await services.webServer.dispatch('GET', '/ui-liteglass/config', AUTH)
  check('fresh config GET 200', res.statusCode === 200)
  check('fresh config body ok', JSON.parse(res.body).ok === true)
  check('fresh config is null', JSON.parse(res.body).config === null)

  res = await services.webServer.dispatch('POST', '/ui-liteglass/config', { ...AUTH, 'content-type': 'text/plain' }, Buffer.from('{}'))
  check('config POST rejects text/plain (415)', res.statusCode === 415)

  res = await services.webServer.dispatch('POST', '/ui-liteglass/config', { ...AUTH, 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:3081' }, Buffer.from('{}'))
  check('config POST rejects cross-origin (403)', res.statusCode === 403)

  res = await services.webServer.dispatch('POST', '/ui-liteglass/config', { ...AUTH, 'content-type': 'application/json', origin: 'http://127.0.0.1:3081', host: '127.0.0.1:3081' }, Buffer.from('not json'))
  check('config POST bad json → ok:false', JSON.parse(res.body).ok === false)
  check('bad json did not write config', await readFile(configFile, 'utf8').then(() => false, () => true))

  res = await services.webServer.dispatch('POST', '/ui-liteglass/config', { ...AUTH, 'content-type': 'application/json' },
    Buffer.from(JSON.stringify({ background: 'url', backgroundImage: 'https://ex.com/w.jpg', backgroundBlur: '999', panelOpacity: -5, accentColor: 'red', accentButtons: 'yes' })))
  const saved = JSON.parse(res.body).config
  check('config POST 200 + sanitized', res.statusCode === 200 && saved.ok !== false && saved.background === 'url')
  check('numbers clamped', saved.backgroundBlur === 40 && saved.panelOpacity === 0)
  check('invalid accent dropped', saved.accentColor === '')
  check('accentButtons is boolean, default false', saved.accentButtons === false)

  const onDisk = JSON.parse(await readFile(configFile, 'utf8'))
  check('config persisted to disk', onDisk.backgroundImage === 'https://ex.com/w.jpg')
  check('full config shape', ['background', 'backgroundImage', 'backgroundOpacity', 'backgroundBlur', 'panelOpacity', 'panelBlur', 'accentColor', 'accentButtons'].every((k) => Object.prototype.hasOwnProperty.call(onDisk, k)))

  console.log('\n== native theme preference (settings.describe(), not get()) ==')
  res = await services.webServer.dispatch('GET', '/ui-liteglass/state', AUTH)
  check('state reports the real preference (dark)', JSON.parse(res.body).nativePreference === 'dark')

  console.log('\n== upload: content type, magic bytes, body limit ==')
  res = await services.webServer.dispatch('POST', '/ui-liteglass/background', { ...AUTH, 'content-type': 'image/svg+xml' }, PNG)
  check('unsupported mime rejected (415)', res.statusCode === 415)

  res = await services.webServer.dispatch('POST', '/ui-liteglass/background', { ...AUTH, 'content-type': 'image/png' }, JPEG)
  check('jpeg bytes declared as png rejected (415)', res.statusCode === 415)

  res = await services.webServer.dispatch('POST', '/ui-liteglass/background', { ...AUTH, 'content-type': 'image/png' }, Buffer.from('plain text, not an image'))
  check('non-image body rejected (415)', res.statusCode === 415)

  const huge = Buffer.alloc(9 * 1024 * 1024, 1)
  PNG.copy(huge, 0)
  res = await services.webServer.dispatch('POST', '/ui-liteglass/background', { ...AUTH, 'content-type': 'image/png' }, huge)
  check('oversized upload rejected (413)', res.statusCode === 413)

  res = await services.webServer.dispatch('POST', '/ui-liteglass/background', { ...AUTH, 'content-type': 'image/png' }, PNG)
  const uploaded = JSON.parse(res.body)
  check('png upload accepted', res.statusCode === 200 && uploaded.ok === true && /^\/ui-liteglass\/backgrounds\/[0-9a-f]{16}\.png$/.test(uploaded.url))

  const name = uploaded.url.split('/').pop()
  res = await services.webServer.dispatch('GET', uploaded.url, AUTH)
  check('background served byte-identical', res.statusCode === 200 && Buffer.compare(res.rawBody, PNG) === 0)
  check('background content type', res.headers['Content-Type'] === 'image/png')
  check('background cache is private', String(res.headers['Cache-Control']).startsWith('private'))

  console.log('\n== traversal + missing file ==')
  res = await services.webServer.dispatch('GET', '/ui-liteglass/backgrounds/..%2Fconfig.json', AUTH)
  check('traversal name rejected (400)', res.statusCode === 400)
  res = await services.webServer.dispatch('GET', '/ui-liteglass/backgrounds/' + '0'.repeat(16) + '.png', AUTH)
  check('missing background 404', res.statusCode === 404)

  console.log('\n== unreferenced files are pruned, referenced ones kept ==')
  const oldFile = join(backgroundsDir, 'a'.repeat(16) + '.png')
  const refFile = join(backgroundsDir, 'b'.repeat(16) + '.png')
  await writeFile(oldFile, PNG)
  await writeFile(refFile, PNG)
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  await utimes(oldFile, old, old)
  await utimes(refFile, old, old)
  await writeFile(configFile, JSON.stringify({ backgroundImage: `/ui-liteglass/backgrounds/${'b'.repeat(16)}.png` }))
  res = await services.webServer.dispatch('POST', '/ui-liteglass/background', { ...AUTH, 'content-type': 'image/png' }, Buffer.concat([PNG, Buffer.from('new')]))
  check('second upload accepted', JSON.parse(res.body).ok === true)
  check('stale unreferenced file pruned', await stat(oldFile).then(() => false, () => true))
  check('referenced file kept', await stat(refFile).then(() => true, () => false))
  check('fresh upload kept', await stat(join(backgroundsDir, name)).then(() => true, () => false))

  console.log('\n== dispose releases every route (live patch reload) ==')
  ctx.dispose()
  check('no routes left after dispose', services.webServer.active().length === 0)
  let noRoute = false
  try { await services.webServer.dispatch('GET', '/ui-liteglass/config', AUTH) } catch (e) { noRoute = /no matching route/.test(e.message) }
  check('disposed plugin no longer serves', noRoute)

  console.log('\n== no files written outside the temp DSH_HOME ==')
  const outsideProbe = join(tmpdir(), 'ui-liteglass-outside-marker')
  let outsideExists = false
  try { outsideExists = (await access(outsideProbe), true) } catch (e) { outsideExists = false }
  check('no files written outside temp DSH_HOME', outsideExists === false)
} catch (e) {
  failed = true
  console.log('\n  UNEXPECTED THROW: ' + (e && e.stack ? e.stack : e))
} finally {
  await rm(tmpHome, { recursive: true, force: true })
}

console.log('\n== RESULT: ' + pass + ' passed, ' + fail + ' failed ==')
if (fail > 0 || failed) process.exit(1)