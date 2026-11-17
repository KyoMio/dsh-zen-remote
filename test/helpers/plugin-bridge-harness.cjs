'use strict'
const http = require('node:http')
const { startResetServer } = require('../util.cjs')

async function waitFor(predicate, timeoutMs = 2000, stepMs = 15) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/**
 * Fake host webServer matching the host's shape (exact/prefixes/upgrades
 * maps, match(pathname), register, registerFallback).
 */
function startFakeHost(initialHits, registerLocal) {
  const hits = { ...initialHits }
  let fallback = undefined
  const raw = {
    exact: new Map(),
    prefixes: new Map(),
    upgrades: new Map(),
    match(pathname) {
      const exact = this.exact.get(pathname)
      if (exact !== undefined) return exact
      let best
      for (const [prefix, route] of this.prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (best === undefined || prefix.length > best.path.length) best = route
      }
      return best
    },
    register(route) {
      const table = route.kind === 'exact' ? this.exact : this.prefixes
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    registerFallback(handler) {
      fallback = handler
      return () => { fallback = undefined }
    },
  }
  const server = http.createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    Promise.resolve(raw.match(rawPath)).then(async (route) => {
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      if (fallback !== undefined) {
        await fallback(req, res)
        return
      }
      res.writeHead(404)
      res.end()
    }).catch(() => { try { res.destroy() } catch { /* gone */ } })
  })
  server.on('upgrade', (req, socket, head) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const entry = raw.upgrades.get(rawPath)
    if (entry !== undefined && typeof entry.handler === 'function') {
      entry.handler(req, socket, head)
      return
    }
    socket.destroy()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        raw,
        hits,
        port,
        stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
        registerLocalPlugin: () => registerLocal(raw, hits),
        get: (pathWithQuery, { headers = {}, signal, method, body } = {}) =>
          fetch(`http://127.0.0.1:${port}${pathWithQuery}`, {
            method: method ?? 'GET',
            headers,
            ...(body !== undefined ? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } : {}),
            signal,
          }),
      })
    })
  })
}

/**
 * Fake relay server speaking relay/v1/plugin. Records hits immediately on
 * request arrival (and fills `.body` on end), tracks aborts, supports
 * programmable `state.reply`, refusal fixtures, streaming, and held responses.
 */
function startFakeRelay({ refuse } = {}) {
  const state = { hits: [], aborted: 0, reply: undefined }
  let hold
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.internal')
    const hit = {
      method: req.method,
      path: url.pathname,
      plugin: req.headers['x-zr-plugin'],
      version: req.headers['x-zr-plugin-version'],
      digest: req.headers['x-zr-plugin-digest'],
      zrPath: req.headers['x-zr-path'],
      zrQuery: req.headers['x-zr-query'],
      accept: req.headers.accept,
      ct: req.headers['content-type'],
      body: '',
    }
    state.hits.push(hit)
    req.on('close', () => { if (!res.writableEnded) state.aborted += 1 })
    if (refuse !== undefined) {
      res.writeHead(refuse.status ?? 403, { 'x-zen-remote-error': refuse.code, 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: refuse.code } }))
      return
    }
    if (url.pathname === '/_dsh/zen-remote/relay/v1/plugin' && req.headers['x-zr-path'] === '/panel/stream') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('frame-1\n')
      setTimeout(() => { res.write('frame-2\n'); res.end() }, 15)
      return
    }
    if (url.pathname === '/_dsh/zen-remote/relay/v1/plugin' && req.headers['x-zr-path'] === '/panel/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('held')
      hold = () => res.end()
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      hit.body = Buffer.concat(chunks).toString('utf8')
      if (state.reply !== undefined) {
        state.reply(req, res, hit.body)
        return
      }
      if (url.pathname === '/_dsh/zen-remote/relay/v1/plugin' && (req.headers['x-zr-path'] === '/panel/write' || req.headers['x-zr-path'] === '/v2/command')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ echoed: hit.body, ct: req.headers['content-type'] }))
        return
      }
      const fallbackBody = JSON.stringify({ remote: true })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(fallbackBody)), 'cache-control': 'no-store' })
      res.end(fallbackBody)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        __port: port,
        state,
        releaseHold: () => { const done = hold; hold = undefined; if (done !== undefined) done() },
        stop: () => new Promise((done) => { server.closeAllConnections(); server.close(done) }),
      })
    })
  })
}

/** Relay client stub mirroring pluginRequest abort vs offline contract. */
function fakeRelayClient(relayPort) {
  const forwarded = []
  const offlineVerdicts = []
  const client = {
    forwarded,
    offlineVerdicts,
    pluginRequest: async (request, signal) => {
      const hasBody = request.body !== undefined && request.body !== null
      forwarded.push({
        method: request.method ?? 'GET',
        contentType: request.contentType,
        contentLength: request.contentLength,
        path: request.path,
        query: request.query,
      })
      const init = {
        method: request.method ?? 'POST',
        headers: {
          accept: request.accept ?? 'application/json',
          ...(request.range !== undefined ? { range: request.range } : {}),
          ...(hasBody && request.contentType !== undefined ? { 'content-type': request.contentType } : {}),
          'x-zr-plugin': request.plugin,
          'x-zr-plugin-version': request.version,
          'x-zr-plugin-digest': request.digest,
          'x-zr-path': request.path,
          'x-zr-query': request.query,
        },
        ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
        signal,
      }
      try {
        return await fetch(`http://127.0.0.1:${relayPort}/_dsh/zen-remote/relay/v1/plugin`, init)
      } catch (error) {
        if (signal?.aborted) {
          throw Object.assign(new Error('aborted'), { code: 'aborted' })
        }
        offlineVerdicts.push({ code: 'offline', message: String((error && error.message) ?? error) })
        throw Object.assign(new Error('offline'), { code: 'offline' })
      }
    },
  }
  return client
}

module.exports = { waitFor, startResetServer, startFakeHost, startFakeRelay, fakeRelayClient }
