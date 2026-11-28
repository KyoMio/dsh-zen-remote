---
name: verify-zen-remote-formal
description: Formally verify pairing/wizard reload/probe reconnect, plugin bridge handshake/503 routing, and gateway-server rate-limiting/auth invariants in dsh-zen-remote with TLC and /statechart. Use after touching pairing, restart-watcher, wizard verify, relay-client reconnect, plugin-bridge/route-intercept, or gateway-server ws-hub/auth/rate-limiter.
---

# Verify Zen Remote Formal Invariants

## Coverage & Sync Commit

- **Confirmed sync commit**: `f93eb25c` (branch `zr7-formal-models`, base `dev`)
- **Rule**: Only advance the sync commit SHA above after re-running all three TLC checks and confirming every action/line reference in `docs/formal/MAPPING.md` still matches the modified source files.

| Model (`docs/formal/`) | Covered Source Files & Functions | Plain-Sentence Guarantee |
|---|---|---|
| `PairingWizardReconnect.tla` | `src/restart-watcher.ts` (`startRestartWatcher`), `src/restart-fields.ts` (`RESTART_FIELDS`), `src/wizard/verify.ts` (`createVerificationManager`), `src/client/wizard/GatewayWizard.tsx`, `src/client-data/remote-status.ts` (`sendNetworkHint`), `src/client-routes.ts` (`CLIENT_NETWORK_HINT_ROUTE`), `src/relay-client.ts` (`probeHealth`, `networkRestored`, `reconnect`), `lib/lan-gate-server.cjs` (`server.on('upgrade')`) | Failed health probes never trigger auto-reconnect; network hints only fire when the view is not `online`; pairing codes only mint after a restart-field reload completes; unauthenticated WS upgrades are always rejected. |
| `PluginBridgeRouting.tla` | `src/plugin-bridge.ts` (`createBridgeRegistry`, `compareBridges`), `src/plugin-adapter-core.ts` (`adapterOwnsRegistryEntry`), `src/index.ts` (adapter registration), `src/plugin-route-intercept.ts` (`surrogateHandler`, `answerUnbridged`, `answerUnbridgedSocket`), `src/plugin-tunnel.ts` | Bridging requires exact plugin name, version, and declaration digest match (plus server-scope consent); unbridged virtual `zr~` routes always return 503 and never reach local handlers; plugin self-declarations always take precedence over adapters. |
| `GatewayRateLimitAuth.tla` | `gateway-server/src/peer-hub/ws-hub.ts` (`resolvePreAuthClientIp`, `setupConnection`), `gateway-server/src/peer-hub/rate-limiter.ts`, `gateway-server/src/http/auth.ts` (`requireAdmin`, `requireUser`, `handleMe`, `handleSendOtp`, `handleResetPassword`, `requestClientIp`), `gateway-server/src/server.ts` (`isBearerAdminApi`) | Untrusted peers cannot spoof `X-Real-IP`/`X-Forwarded-For` to bypass pre-auth 1013 limits; `requireAdmin` prioritizes `Authorization: Bearer` without falling back to Cookie; OTP endpoints never issue an admin session. |

## How to Run

1. Run TLC (version 2.19 via Homebrew `/opt/homebrew/bin/tlc`) on all three passing configurations from the repo root:

```sh
tlc -workers 1 -metadir /tmp/tlc-s1 -config docs/formal/PairingWizardReconnect.cfg docs/formal/PairingWizardReconnect.tla
tlc -workers 1 -metadir /tmp/tlc-s2 -config docs/formal/PluginBridgeRouting.cfg docs/formal/PluginBridgeRouting.tla
tlc -workers 1 -metadir /tmp/tlc-s3 -config docs/formal/GatewayRateLimitAuth.cfg docs/formal/GatewayRateLimitAuth.tla
```

2. Run the stricter finding probe (expected exit `12` while the two documented open-source gaps in `gateway-server/src/http/auth.ts` remain open):

```sh
tlc -workers 1 -metadir /tmp/tlc-s3f -config docs/formal/GatewayRateLimitAuth-finding.cfg docs/formal/GatewayRateLimitAuth.tla
```

3. Read every result and refresh Mermaid `.mmd` diagrams using the pstack `/statechart` skill (by name — pass each spec with its matching `.cfg` and `.view.mjs` file into a fresh `/tmp` `--out` directory, then inspect `report.md` and `chart.mmd`). Never commit TLC `states/` directories into the repo.

## Interpreting Failures (Real Bug vs Modeling Error)

- **Code changed without updating the model**: Compare your diff against `docs/formal/MAPPING.md`. If you intentionally changed state transitions or added a new route/guard, update the corresponding `.tla`, `.view.mjs`, and `MAPPING.md`, regenerate `.mmd` via `/statechart`, and move the sync commit forward. Use `/maintain-formal-verification-skill` when syncing after out-of-band code edits.
- **Model check failed on an untouched invariant**: Replay the shortest counterexample path reported by `/statechart` step by step against the real TypeScript/JavaScript code. Do not weaken an invariant to make TLC pass; report or fix the code defect instead.
- **Repo packaging & sanitization**: `docs/formal/` must remain excluded via `"!docs/formal"` in `package.json`, and `pnpm test` (`test/architecture-guardrails.test.cjs`) enforces zero production-site vocabulary across all tracked files.
