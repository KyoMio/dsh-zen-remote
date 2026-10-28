/**
 * Reverse-proxy configuration snippets (GW-5, 路 B) — for the user who
 * ALREADY runs their own proxy, the wizard hands out copy-paste material
 * instead of managing a process. Everything here is pure text generation:
 * every interpolated value passes a charset gate (the domain through
 * config.ts's `hostOf`, the upstream host likewise, the port in [1,
 * 65535]), so a hostile form value cannot smuggle a directive into
 * anyone's nginx.
 *
 * The upstream port is the gateway's ACTUAL port — the caller reads it
 * from the running gateway (it may have retried past the configured one),
 * never from config.
 */

import { hostOf } from '../config.js'

export type SnippetResult =
  | { ok: true; text: string }
  | { ok: false; error: 'bad-domain' | 'bad-upstream-host' | 'bad-upstream-port' }

export interface SnippetInput {
  /** Public domain the proxy terminates TLS for (bare hostname). */
  domain: unknown
  /** Where the gateway listens — a hostname or IP literal (e.g. the
   * loopback default). */
  upstreamHost: unknown
  /** The gateway's ACTUAL port. */
  upstreamPort: unknown
}

/** Integers in [1, 65535] only. */
function portOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined
}

function validatedParts(input: SnippetInput): { domain: string; upstream: string; port: number } | { error: SnippetResult & { ok: false } } {
  const domain = hostOf(input.domain)
  if (domain === undefined) return { error: { ok: false, error: 'bad-domain' } }
  const upstream = hostOf(input.upstreamHost)
  if (upstream === undefined) return { error: { ok: false, error: 'bad-upstream-host' } }
  const port = portOf(input.upstreamPort)
  if (port === undefined) return { error: { ok: false, error: 'bad-upstream-port' } }
  return { domain, upstream, port }
}

/**
 * nginx: a complete server block. The WebSocket upgrade map sits outside
 * the server (http-level context) — the snippet says so in a comment, the
 * user pastes it into the http/server scope their setup offers. Long
 * idle tunnels need the 3600s read/send timeouts, uploads the 512m
 * client body cap (nginx's `m` is MiB — 512m covers the relay's 500 MiB
 * upload ceiling with headroom), and streaming the buffering switch — all
 * three are the shapes DSH's relay traffic actually needs.
 */
export function nginxSnippet(input: SnippetInput): SnippetResult {
  const parts = validatedParts(input)
  if ('error' in parts) return parts.error
  const { domain, upstream, port } = parts
  const text = [
    '# 这段放在 http {} 层（若已有同名 map 则跳过）',
    'map $http_upgrade $connection_upgrade {',
    '    default upgrade;',
    "    ''      close;",
    '}',
    '',
    'server {',
    '    listen 443 ssl;',
    `    server_name ${domain};`,
    '',
    '    location / {',
    `        proxy_pass http://${upstream}:${port};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection $connection_upgrade;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_buffering off;',
        '        client_max_body_size 512m;',
    '        proxy_read_timeout 3600s;',
    '        proxy_send_timeout 3600s;',
    '    }',
    '}',
    '',
  ].join('\n')
  return { ok: true, text }
}

/**
 * Caddy (user-operated, not the wizard-managed one): the site block is
 * one `reverse_proxy` line — Caddy routes the rest itself.
 */
export function caddySnippet(input: SnippetInput): SnippetResult {
  const parts = validatedParts(input)
  if ('error' in parts) return parts.error
  const { domain, upstream, port } = parts
  const text = [
    `${domain} {`,
    `    reverse_proxy ${upstream}:${port}`,
    '}',
    '',
  ].join('\n')
  return { ok: true, text }
}

export type StepsResult =
  | { ok: true; steps: string[] }
  | { ok: false; error: 'bad-upstream-host' | 'bad-upstream-port' }

/**
 * Lucky (Web 服务反代) three steps: listen 443, proxy to the upstream,
 * flip the catch-all switch. Text only — Lucky has no config file format
 * to generate.
 */
export function luckySteps(input: { upstreamHost: unknown; upstreamPort: unknown }): StepsResult {
  const upstream = hostOf(input.upstreamHost)
  if (upstream === undefined) return { ok: false, error: 'bad-upstream-host' }
  const port = portOf(input.upstreamPort)
  if (port === undefined) return { ok: false, error: 'bad-upstream-port' }
  return {
    ok: true,
    steps: [
      '在 Lucky 的「Web 服务」里新建一条规则，监听 443 端口，绑定你的域名。',
      `后端（反代目标）填 http://${upstream}:${port}，开启 WebSocket 支持。`,
      '打开「万事大吉」开关（放行全部路径），保存即可生效。',
    ],
  }
}
