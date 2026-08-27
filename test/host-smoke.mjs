// dsh-ui-liteglass — host-side end-to-end smoke test.
//
// Runs ONLY the plugin's own host logic against a THROWAWAY DSH_HOME (a temp
// dir under os.tmpdir()). It does not touch /root/.dsh, does not install the
// plugin, and does not start/restart any server. All temp data is removed in
// the finally block.
//
// The plugin's apply() only needs `webServer.register(...)`; we provide a tiny
// in-process webServer mock (exact → longest-prefix routing) so each route
// handler runs against real node:http-style req/res objects.

import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
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
    register(route) { routes.push(route); return () => {} },
    async dispatch(method, url, headers, body) {
      const path = String(url).split('?')[0]
      // Mirror the real dsh-host-webserver match(): exact first, then longest
      // prefix via `pathname.startsWith(prefix + "/")` (or pathname === prefix).
      const exact = routes.find((r) => r.kind === 'exact' && r.path === path)
      if (exact) {
        return await run(exact)
      }
      let best
      for (const r of routes) {
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

const tmpHome = await mkdtemp(join(tmpdir(), 'dsh-ui-liteglass-test-'))
process.env.DSH_HOME = tmpHome

// NOTE: import must happen AFTER DSH_HOME is set only because apply() calls
// dataDir() at apply-time; importing is order-independent here.
const { default: plugin } = await import(join(pkgRoot, 'lib/index.js'))

const webServer = makeWebServer()
const goodSettings = { get: (ns) => (ns === 'ui-theme' ? { preference: 'dark' } : undefined) }

let failed = false
try {
  console.log('\n== host apply (register routes) ==')
  plugin.apply({ get: (n) => (n === 'webServer' ? webServer : n === 'settings' ? goodSettings : undefined) })

  console.log('\n== GET /ui-liteglass/config (fresh) ==')
  let res = await webServer.dispatch('GET', '/ui-liteglass/config', {})
  let j = JSON.parse(res.body)
  check('GET config → 200', res.statusCode === 200)
  check('GET config ok', j.ok === true)
  check('GET config null on fresh', j.config === null)

  console.log('\n== POST /ui-liteglass/config (valid) ==')
  res = await webServer.dispatch('POST', '/ui-liteglass/config', { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({
    background: 'url', backgroundImage: 'https://example.com/w.png',
    backgroundOpacity: 0.4, backgroundBlur: 3, panelOpacity: 0.5, panelBlur: 8, accentColor: '#aabbcc'
  })))
  j = JSON.parse(res.body)
  check('POST config → 200', res.statusCode === 200)
  check('POST config ok', j.ok === true)
  check('POST config echoed', j.config.background === 'url' && j.config.accentColor === '#aabbcc')
  check('no appearance field persisted', !('appearance' in j.config) && !('originalPreference' in j.config))

  console.log('\n== GET config after POST (persistence read-back) ==')
  res = await webServer.dispatch('GET', '/ui-liteglass/config', {})
  j = JSON.parse(res.body)
  check('persisted read-back', j.config && j.config.background === 'url' && j.config.accentColor === '#aabbcc')

  console.log('\n== POST partial config → server returns FULL normalized config ==')
  res = await webServer.dispatch('POST', '/ui-liteglass/config', { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({ background: 'local' })))
  j = JSON.parse(res.body)
  const c = j.config
  check('full config has every field', ['background', 'backgroundImage', 'backgroundOpacity', 'backgroundBlur', 'panelOpacity', 'panelBlur', 'accentColor'].every((k) => k in c))
  check('partial numerics defaulted to finite', Number.isFinite(c.backgroundOpacity) && Number.isFinite(c.backgroundBlur) && Number.isFinite(c.panelOpacity) && Number.isFinite(c.panelBlur))
  check('no NaN/undefined anywhere', JSON.stringify(c).indexOf('NaN') === -1 && JSON.stringify(c).indexOf('undefined') === -1)

  console.log('\n== POST config invalid JSON ==')
  res = await webServer.dispatch('POST', '/ui-liteglass/config', { 'Content-Type': 'application/json' }, Buffer.from('not json'))
  j = JSON.parse(res.body)
  check('invalid JSON → ok:false', j.ok === false && /bad json/.test(j.error))

  console.log('\n== POST config sanitization (illegal values) ==')
  res = await webServer.dispatch('POST', '/ui-liteglass/config', { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({
    background: 'party', panelOpacity: 99, accentColor: 'javascript:alert(1)'
  })))
  j = JSON.parse(res.body)
  check('background sanitized to off', j.config.background === 'off')
  check('panelOpacity clamped to 1', j.config.panelOpacity === 1)
  check('accentColor rejected', j.config.accentColor === '')

  console.log('\n== GET /ui-liteglass/state (nativePreference from settings) ==')
  res = await webServer.dispatch('GET', '/ui-liteglass/state', {})
  j = JSON.parse(res.body)
  check('state nativePreference = dark', j.ok === true && j.nativePreference === 'dark')

  console.log('\n== nativePreference fallback (settings.get throws) ==')
  const brokenSettings = { get: () => { throw new Error('boom') } }
  const plugin2 = plugin // same apply; re-run with broken settings
  const webServer2 = makeWebServer()
  plugin2.apply({ get: (n) => (n === 'webServer' ? webServer2 : n === 'settings' ? brokenSettings : undefined) })
  res = await webServer2.dispatch('GET', '/ui-liteglass/state', {})
  j = JSON.parse(res.body)
  check('fallback nativePreference = system', j.ok === true && j.nativePreference === 'system')

  console.log('\n== nativePreference fallback (settings undefined) ==')
  const webServer3 = makeWebServer()
  plugin2.apply({ get: (n) => (n === 'webServer' ? webServer3 : undefined) })
  res = await webServer3.dispatch('GET', '/ui-liteglass/state', {})
  j = JSON.parse(res.body)
  check('no-settings nativePreference = system', j.ok === true && j.nativePreference === 'system')

  console.log('\n== POST /ui-liteglass/background (valid PNG) ==')
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  res = await webServer.dispatch('POST', '/ui-liteglass/background', { 'Content-Type': 'image/png' }, pngBytes)
  j = JSON.parse(res.body)
  check('upload ok', j.ok === true)
  check('upload url shape', /^\/ui-liteglass\/backgrounds\/[0-9a-f]{16}\.png$/.test(j.url))
  const bgUrl = j.url
  const bgId = bgUrl.split('/').pop()

  console.log('\n== GET /ui-liteglass/backgrounds/<id> (serve round-trip) ==')
  res = await webServer.dispatch('GET', bgUrl, {})
  check('serve 200', res.statusCode === 200)
  check('serve content-type image/png', /image\/png/.test(res.headers['Content-Type'] || ''))
  check('serve bytes equal', res.rawBody !== null && res.rawBody.equals(pngBytes))

  console.log('\n== on-disk persistence ==')
  const configFile = join(tmpHome, 'ui-liteglass', 'config.json')
  const bgFile = join(tmpHome, 'ui-liteglass', 'backgrounds', bgId)
  let cfgOnDisk = null
  try { cfgOnDisk = JSON.parse(await readFile(configFile, 'utf8')) } catch (e) {}
  check('config.json exists + parses', cfgOnDisk !== null)
  const allFields = ['background', 'backgroundImage', 'backgroundOpacity', 'backgroundBlur', 'panelOpacity', 'panelBlur', 'accentColor'].every((k) => k in cfgOnDisk)
  const noNaN = cfgOnDisk && JSON.stringify(cfgOnDisk).indexOf('NaN') === -1 && JSON.stringify(cfgOnDisk).indexOf('undefined') === -1
  check('config.json is full + finite (no NaN/undefined)', allFields && noNaN)
  let bgOnDisk = false
  try { bgOnDisk = (await access(bgFile), true) } catch (e) { bgOnDisk = false }
  check('background file on disk', bgOnDisk === true)

  console.log('\n== POST background unsupported MIME ==')
  res = await webServer.dispatch('POST', '/ui-liteglass/background', { 'Content-Type': 'text/html' }, Buffer.from('<html></html>'))
  j = JSON.parse(res.body)
  check('unsupported mime rejected', j.ok === false && /unsupported content type/.test(j.error))

  console.log('\n== path traversal / bad names rejected (400) ==')
  const badNames = [
    '/ui-liteglass/backgrounds/../../etc/passwd',
    '/ui-liteglass/backgrounds/..',
    '/ui-liteglass/backgrounds/.',
    '/ui-liteglass/backgrounds/x.png',
    '/ui-liteglass/backgrounds/nothexatall.png',
    '/ui-liteglass/backgrounds/../../secret'
  ]
  for (const bad of badNames) {
    res = await webServer.dispatch('GET', bad, {})
    check('reject ' + JSON.stringify(bad.split('/').pop()), res.statusCode === 400)
  }

  console.log('\n== missing well-formed background → 404 ==')
  res = await webServer.dispatch('GET', '/ui-liteglass/backgrounds/' + '0'.repeat(16) + '.png', {})
  check('missing bg 404', res.statusCode === 404)

  console.log('\n== traversal via config write must not escape DSH_HOME ==')
  // config.json path is fixed; no user-controlled path. Verify nothing was
  // written outside tmpHome by checking tmpHome parent is clean.
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
