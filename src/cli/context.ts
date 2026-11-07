/**
 * CLI-3: the execution context every command function receives. One bag with
 * everything a command needs but never constructs itself — the parsed
 * grammar, the live IPC client, the translator, and the interactivity
 * verdict — plus the seams tests inject (a clock, a poll interval, an
 * alternate working directory). Pure types: the real builder is CLI-5's
 * main.ts; the tests assemble the object literal directly.
 */

import type { ParsedCliArgs } from './args.js'
import type { CliIpcClient } from './ipc-client.js'
import type { CliTranslator } from './i18n.js'
import type { CliPrompter } from './bootstrap.js'

export interface CliExecutionContext {
  /** The command and options this run parsed. */
  args: ParsedCliArgs
  /** A client bound to the discovered live IPC socket. */
  ipc: CliIpcClient
  /** The translator for this run's language. */
  t: CliTranslator
  /** TTY && !`--yes`, decided once by the entry point (isInteractiveSession). */
  interactive: boolean
  /** The ask-everything funnel; present whenever the run may prompt. */
  prompter?: CliPrompter
  stdout: { write(text: string): void }
  /** Clock for the `status --debug` default filename; default `new Date()`. */
  now?: () => Date
  /** Working directory for that default path; default `process.cwd()`. */
  cwd?: string
  /** `client pair`'s online-wait poll interval (default 250ms; tests shrink
   * it — the 10s budget itself stays fixed). */
  pollIntervalMs?: number
}
