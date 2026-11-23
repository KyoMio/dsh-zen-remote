import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

test('lib/client.js externals stay within the DSH allowlist', () => {
  const clientJs = join(root, 'lib', 'client.js')
  const ALLOWED = [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-slots',
  ]

  const specifiers = new Set()
  const source = readFileSync(clientJs, 'utf8')
  for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
    const specifier = match[2]
    if (specifier.startsWith('.')) continue
    specifiers.add(specifier)
  }

  const extra = [...specifiers].filter((specifier) => !ALLOWED.includes(specifier))
  assert.deepEqual(
    extra,
    [],
    `lib/client.js requires packages outside the allowlist: ${extra.join(', ')}`,
  )
})

test('host runtime entries do not shadow @deepseek-ai/* or retain banned packages', () => {
  const pluginNodeModules = join(root, 'node_modules')
  const SHADOW_ALLOWED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session']
  const BANNED_PACKAGES = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-host-apiproxy']
  const HOST_ENTRY_FILES = ['dsh-push.mjs', 'lan-gate.mjs', 'lib/index.js', 'lib/share-export.js', 'lib/fingerprint.js']
  const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@deepseek-ai\/[^'"\s]+)['"]/g
  const packageNameOf = (specifier) => specifier.split('/').slice(0, 2).join('/')
  const insidePluginNodeModules = (resolved) => resolved.startsWith(pluginNodeModules + sep)

  const found = new Map()
  for (const file of HOST_ENTRY_FILES) {
    const filePath = join(root, file)
    assert.ok(existsSync(filePath), `host entry file is missing: ${file}`)
    for (const [, specifier] of readFileSync(filePath, 'utf8').matchAll(IMPORT_SPECIFIER)) {
      const name = packageNameOf(specifier)
      if (!found.has(name)) found.set(name, [])
      if (!found.get(name).includes(file)) found.get(name).push(file)
    }
  }

  const failures = []
  for (const packageName of BANNED_PACKAGES) {
    if (existsSync(join(pluginNodeModules, ...packageName.split('/')))) {
      failures.push(`${packageName} must not exist inside plugin node_modules`)
    }
  }

  for (const [packageName, files] of found) {
    let resolved
    try {
      resolved = require.resolve(packageName)
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND') continue
      assert.match(
        error?.code ?? '',
        /^ERR_(PACKAGE_PATH_NOT_EXPORTED|INVALID_PACKAGE_TARGET)$/,
        `unexpected error resolving ${packageName}: ${error?.message}`,
      )
      if (!existsSync(join(pluginNodeModules, ...packageName.split('/')))) continue
      resolved = join(pluginNodeModules, ...packageName.split('/'))
    }
    if (!insidePluginNodeModules(resolved) && !existsSync(join(pluginNodeModules, ...packageName.split('/')))) {
      continue
    }
    if (SHADOW_ALLOWED.includes(packageName)) continue
    failures.push(`${packageName} in plugin node_modules (imported by ${files.join(', ')}) at ${resolved}`)
  }

  assert.deepEqual(failures, [], `host shadow failures:\n  ${failures.join('\n  ')}`)
})

test('upload-limits stays single-sourced across docs, nginx snippet, and repo constants', async () => {
  const limits = await import(pathToFileURL(join(root, 'lib', 'upload-limits.js')).href)
  const capMib = limits.MAX_UPLOAD_BYTES / (1024 * 1024)
  const failures = []

  const DOCS = ['docs/remote-access.md', 'docs/remote-access.en.md']
  for (const file of DOCS) {
    const row = readFileSync(join(root, file), 'utf8')
      .split('\n')
      .find((line) => /^\|\s*`\/v1\/upload`\s*\|/.test(line))
    if (row === undefined) {
      failures.push(`${file}: no \`/v1/upload\` table row found`)
      continue
    }
    const mibs = [...row.matchAll(/(\d+(?:\.\d+)?)\s*MiB/g)].map((match) => Number(match[1]))
    if (mibs.length === 0) {
      failures.push(`${file}: the \`/v1/upload\` row states no MiB cap`)
      continue
    }
    for (const mib of mibs) {
      if (mib !== capMib) failures.push(`${file}: \`/v1/upload\` row says ${mib} MiB, expected ${capMib} MiB`)
    }
  }

  const NGINX_CAP = /client_max_body_size\s+(\d+)m\s*;/g
  const nginxCapsOf = (text) => [...text.matchAll(NGINX_CAP)].map((match) => Number(match[1]))

  const { nginxSnippet } = await import(pathToFileURL(join(root, 'lib', 'wizard', 'proxy-snippets.js')).href)
  const snippet = nginxSnippet({ domain: 'dsh.example.com', upstreamHost: '127.0.0.1', upstreamPort: 4088 })
  if (!snippet.ok) {
    failures.push('wizard nginxSnippet refused a valid input')
  } else {
    const caps = nginxCapsOf(snippet.text)
    if (caps.length === 0) failures.push('wizard nginx snippet: no `client_max_body_size` found')
    for (const cap of caps) {
      if (cap < capMib) failures.push(`wizard nginx snippet: client_max_body_size ${cap}m < ${capMib}m`)
    }
  }

  for (const file of DOCS) {
    const caps = nginxCapsOf(readFileSync(join(root, file), 'utf8'))
    if (file === 'docs/remote-access.md' && caps.length === 0) {
      failures.push(`${file}: no nginx \`client_max_body_size\` example found`)
    }
    for (const cap of caps) {
      if (cap < capMib) failures.push(`${file}: client_max_body_size ${cap}m < ${capMib}m`)
    }
  }

  const LIMIT_VALUES = Object.entries({
    MAX_UPLOAD_BYTES: limits.MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES: limits.DEFAULT_MAX_UPLOAD_BYTES,
    MAX_INVOKE_BODY_BYTES: limits.MAX_INVOKE_BODY_BYTES,
  })
  const GUARDED = 'src/upload-limits.ts'
  const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist'])
  const SCAN_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/

  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (SCAN_EXT.test(entry.name)) {
        files.push(full)
      }
    }
  }
  walk(join(root, 'src'))
  walk(join(root, 'test'))
  walk(join(root, 'scripts'))
  walk(join(root, 'pwa'))
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && SCAN_EXT.test(entry.name)) files.push(join(root, entry.name))
  }

  for (const full of files) {
    const rel = relative(root, full).split('\\').join('/')
    if (rel === GUARDED) continue
    const text = readFileSync(full, 'utf8')
    for (const [name, bytes] of LIMIT_VALUES) {
      const mib = bytes / (1024 * 1024)
      const defines = new RegExp(
        `\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*(?::[^=\\n]+)?=\\s*${mib}\\s*\\*\\s*1024\\s*\\*\\s*1024\\b`,
      )
      if (defines.test(text)) {
        failures.push(`${rel}: defines a ${mib} MiB upload-limit literal — import ${name} from src/upload-limits.ts`)
      }
    }
  }

  assert.deepEqual(failures, [], `upload-limits drift:\n  ${failures.join('\n  ')}`)
})

test('Task 6: gatewayVersion sync, release-check gating, and publish.yml gateway tag guard', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const gwPkg = JSON.parse(readFileSync(join(root, 'gateway-server', 'package.json'), 'utf8'))
  assert.match(gwPkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'gateway-server/package.json#version must be a valid semver')
  assert.equal(pkg.gatewayVersion, gwPkg.version, 'root package.json#gatewayVersion must match gateway-server')

  const syncScript = readFileSync(join(root, 'scripts', 'sync-doc-version.mjs'), 'utf8')
  assert.match(syncScript, /--release-check/, 'sync-doc-version must gate warnings behind --release-check / npm version')

  const publishYml = readFileSync(join(root, '.github', 'workflows', 'publish.yml'), 'utf8')
  const guardIdx = publishYml.indexOf('gateway-v')
  const publishIdx = publishYml.indexOf('pnpm publish')
  assert.ok(guardIdx !== -1 && publishIdx !== -1 && guardIdx < publishIdx,
    'publish.yml must check gateway-v<gatewayVersion> before pnpm publish')
  assert.match(publishYml, /git rev-parse[^\n]*refs\/tags\//,
    'publish.yml must verify refs/tags/ for gateway tag guard')
})
