/**
 * Pure in-memory LRU cache for conditional `v1/invoke` binary previews
 * (`workspaceFiles/readBytes`, `officeToPdf/render`, `officeKit/render`).
 *
 * Zero DSH imports, zero disk/network I/O. Stored and returned values are
 * cloned (including isolated `Uint8Array` copies) so caller mutations cannot
 * corrupt cached entries.
 */

export const IF_VERSION_HEADER = 'x-zr-if-version'
export const DEFAULT_PREVIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_PREVIEW_CACHE_MAX_ENTRY_BYTES = 25 * 1024 * 1024
export const DEFAULT_PREVIEW_CACHE_MAX_ENTRIES = 32

const MAX_WALK_DEPTH = 16
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export interface PreviewCacheOptions {
  maxBytes?: number
  maxEntryBytes?: number
  maxEntries?: number
}

export interface PreviewCacheEntry {
  version: string
  value: unknown
  byteLength: number
}

export interface PreviewCacheStats {
  entries: number
  bytes: number
  maxBytes: number
  maxEntryBytes: number
  maxEntries: number
}

export function estimateValueBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return 16
  }
  if (typeof value === 'string') {
    return value.length * 2 + 32
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength + 64
  }
  if (depth >= MAX_WALK_DEPTH) {
    return 64
  }
  if (Array.isArray(value)) {
    let total = 64
    for (let i = 0; i < value.length; i++) {
      total += estimateValueBytes(value[i], depth + 1)
    }
    return total
  }
  if (typeof value === 'object') {
    let total = 64
    for (const [key, item] of Object.entries(value)) {
      total += key.length * 2 + 32 + estimateValueBytes(item, depth + 1)
    }
    return total
  }
  return 16
}

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth >= MAX_WALK_DEPTH || value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      parts.push(item === undefined ? 'null' : canonicalJson(item, depth + 1))
    }
    return `[${parts.join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    const item = obj[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}

function clonePreviewValue(value: unknown, depth = 0): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const copy = new Uint8Array(view.byteLength)
    copy.set(view)
    return copy
  }
  if (depth >= MAX_WALK_DEPTH || value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => clonePreviewValue(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    out[key] = clonePreviewValue(item, depth + 1)
  }
  return out
}

export class PreviewCache {
  private readonly maxBytes: number
  private readonly maxEntryBytes: number
  private readonly maxEntries: number
  private readonly entries = new Map<string, PreviewCacheEntry>()
  private totalBytes = 0

  constructor(options: PreviewCacheOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_PREVIEW_CACHE_MAX_BYTES
    const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_PREVIEW_CACHE_MAX_ENTRY_BYTES
    const maxEntries = options.maxEntries ?? DEFAULT_PREVIEW_CACHE_MAX_ENTRIES
    for (const val of [maxBytes, maxEntryBytes, maxEntries]) {
      if (!Number.isSafeInteger(val) || val < 1) {
        throw new RangeError('PreviewCache limits must be positive safe integers')
      }
    }
    this.maxBytes = maxBytes
    this.maxEntryBytes = maxEntryBytes
    this.maxEntries = maxEntries
  }

  get(key: string): PreviewCacheEntry | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return {
      version: entry.version,
      value: clonePreviewValue(entry.value),
      byteLength: entry.byteLength,
    }
  }

  set(key: string, version: string, value: unknown): boolean {
    if (typeof key !== 'string' || key === '' || typeof version !== 'string' || version === '') {
      return false
    }
    const byteLength = estimateValueBytes(value)
    if (byteLength > this.maxEntryBytes || byteLength > this.maxBytes) {
      // Remove stale cached version for this key without evicting warm entries.
      this.delete(key)
      return false
    }
    this.delete(key)
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries || this.totalBytes + byteLength > this.maxBytes)
    ) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.delete(oldestKey)
    }
    const stored: PreviewCacheEntry = {
      version,
      value: clonePreviewValue(value),
      byteLength,
    }
    this.entries.set(key, stored)
    this.totalBytes += byteLength
    return true
  }

  delete(key: string): boolean {
    const existing = this.entries.get(key)
    if (existing === undefined) return false
    this.entries.delete(key)
    this.totalBytes -= existing.byteLength
    return true
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  stats(): PreviewCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      maxEntryBytes: this.maxEntryBytes,
      maxEntries: this.maxEntries,
    }
  }
}
