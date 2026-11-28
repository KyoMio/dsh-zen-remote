---- MODULE PairingWizardReconnect ----
(***************************************************************************)
(* Subsystem 1: Pairing + Wizard Reload Survival + Probe Reconnect (ZR-7)  *)
(*                                                                         *)
(* Faithful abstraction of:                                                *)
(*   - src/restart-watcher.ts (startRestartWatcher, RESTART_FIELDS)        *)
(*   - src/index.ts (fiber.restart on restart-field change)                *)
(*   - src/wizard/verify.ts (verificationFingerprint, start, check)        *)
(*   - src/client/wizard/GatewayWizard.tsx (probeAccessUrl retry + mint)   *)
(*   - src/client-data/remote-status.ts (sendNetworkHint online gate)      *)
(*   - src/client-routes.ts (CLIENT_NETWORK_HINT_ROUTE probe-before-rest.) *)
(*   - src/relay-client.ts (probeHealth orthogonal to state, networkRest.) *)
(*   - lib/lan-gate-server.cjs (server.on('upgrade') auth + TOCTOU recheck)*)
(***************************************************************************)
EXTENDS Integers, TLC

VARIABLES
  configGen,           \* 0 = initial config, 1 = wizard edited a RESTART_FIELDS entry
  rowGen,              \* generation currently running in the reloaded plugin row
  wizardPhase,         \* "idle" | "reloading" | "ready"
  codeMintedAtGen,     \* -1 if no pairing code minted, else rowGen at mint time
  paired,              \* TRUE after ClaimPairing succeeds, FALSE before or after RevokeDevice
  relayState,          \* "unpaired" | "offline" | "connecting" | "online"
  viewState,           \* "offline" | "online" (UI snapshot.view?.state, lags behind relayState)
  hintInFlight,        \* TRUE while probeHealth() HTTP GET /ping is awaiting network
  lastHintSawView,     \* "none" | "offline" | "online" (viewState captured when hint started)
  probeResult,         \* "none" | "ok" | "fail"
  lastReconnectSource, \* "none" | "probe_ok" | "manual" | "probe_fail"
  wsState,             \* "closed" | "upgrading" | "open" (2-step lan-gate-server upgrade)
  wsAdmittedAuthed,    \* TRUE if WsUpgradeStart saw valid device auth
  wsOpenAuthed         \* TRUE if WsUpstreamReady passed recheck while paired

vars == <<
  configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
  relayState, viewState, hintInFlight, lastHintSawView, probeResult,
  lastReconnectSource, wsState, wsAdmittedAuthed, wsOpenAuthed
>>

TypeOK ==
  /\ configGen \in {0, 1}
  /\ rowGen \in {0, 1}
  /\ wizardPhase \in {"idle", "reloading", "ready"}
  /\ codeMintedAtGen \in {-1, 0, 1}
  /\ paired \in BOOLEAN
  /\ relayState \in {"unpaired", "offline", "connecting", "online"}
  /\ viewState \in {"offline", "online"}
  /\ hintInFlight \in BOOLEAN
  /\ lastHintSawView \in {"none", "offline", "online"}
  /\ probeResult \in {"none", "ok", "fail"}
  /\ lastReconnectSource \in {"none", "probe_ok", "manual", "probe_fail"}
  /\ wsState \in {"closed", "upgrading", "open"}
  /\ wsAdmittedAuthed \in BOOLEAN
  /\ wsOpenAuthed \in BOOLEAN

Init ==
  /\ configGen = 0
  /\ rowGen = 0
  /\ wizardPhase = "idle"
  /\ codeMintedAtGen = -1
  /\ paired = FALSE
  /\ relayState = "unpaired"
  /\ viewState = "offline"
  /\ hintInFlight = FALSE
  /\ lastHintSawView = "none"
  /\ probeResult = "none"
  /\ lastReconnectSource = "none"
  /\ wsState = "closed"
  /\ wsAdmittedAuthed = FALSE
  /\ wsOpenAuthed = FALSE

\* ---- Wizard & Row Reload ----

WizardOpenWithoutRestart ==
  /\ wizardPhase = "idle"
  /\ rowGen = configGen
  /\ wizardPhase' = "ready"
  /\ UNCHANGED <<configGen, rowGen, codeMintedAtGen, paired, relayState, viewState,
               hintInFlight, lastHintSawView, probeResult, lastReconnectSource,
               wsState, wsAdmittedAuthed, wsOpenAuthed>>

\* Editing a RESTART_FIELDS entry (pre- or post-pairing) invalidates verification session,
\* drops open WS tunnels on gateway restart, and pauses until fiber.restart() finishes.
WizardEditRestartField ==
  /\ wizardPhase \in {"idle", "ready"}
  /\ configGen = 0
  /\ configGen' = 1
  /\ wizardPhase' = "reloading"
  /\ codeMintedAtGen' = -1
  /\ relayState' = IF paired THEN "offline" ELSE "unpaired"
  /\ hintInFlight' = FALSE
  /\ lastHintSawView' = "none"
  /\ lastReconnectSource' = "none"
  /\ probeResult' = "none"
  /\ wsState' = "closed"
  /\ wsAdmittedAuthed' = FALSE
  /\ wsOpenAuthed' = FALSE
  /\ UNCHANGED <<rowGen, paired, viewState>>

CompleteRowReload ==
  /\ wizardPhase = "reloading"
  /\ rowGen < configGen
  /\ rowGen' = configGen
  /\ wizardPhase' = "ready"
  /\ UNCHANGED <<configGen, codeMintedAtGen, paired, relayState, viewState,
               hintInFlight, lastHintSawView, probeResult, lastReconnectSource,
               wsState, wsAdmittedAuthed, wsOpenAuthed>>

MintPairingCode ==
  /\ wizardPhase = "ready"
  /\ rowGen = configGen
  /\ codeMintedAtGen = -1
  /\ ~paired
  /\ codeMintedAtGen' = rowGen
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, paired, relayState, viewState,
               hintInFlight, lastHintSawView, probeResult, lastReconnectSource,
               wsState, wsAdmittedAuthed, wsOpenAuthed>>

\* ClaimPairing moves relayState -> "online"; viewState lags behind until StatusPollSync!
ClaimPairing ==
  /\ codeMintedAtGen = rowGen
  /\ ~paired
  /\ paired' = TRUE
  /\ relayState' = "online"
  /\ probeResult' = "none"
  /\ lastReconnectSource' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, viewState,
               hintInFlight, lastHintSawView, wsState, wsAdmittedAuthed, wsOpenAuthed>>

\* ---- WebSocket Upgrade Gate & 2-Step upstreamConnect TOCTOU (lan-gate-server.cjs:1450-1506) ----

\* Unauthenticated remote WS upgrade is immediately rejected with 403 Forbidden.
RejectUnauthWsUpgrade ==
  /\ ~paired
  /\ wsState = "closed"
  /\ UNCHANGED vars

\* Authenticated WS upgrade passes initial gate (depends on paired, NOT sub-client relayState).
WsUpgradeStart ==
  /\ paired
  /\ wsState = "closed"
  /\ wsState' = "upgrading"
  /\ wsAdmittedAuthed' = TRUE
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               relayState, viewState, hintInFlight, lastHintSawView, probeResult,
               lastReconnectSource, wsOpenAuthed>>

\* Upstream TCP connect callback re-checks live === device before registering openSockets.
WsUpstreamReady ==
  /\ wsState = "upgrading"
  /\ IF paired /\ wsAdmittedAuthed
     THEN /\ wsState' = "open"
          /\ wsOpenAuthed' = TRUE
          /\ wsAdmittedAuthed' = FALSE
     ELSE /\ wsState' = "closed"
          /\ wsOpenAuthed' = FALSE
          /\ wsAdmittedAuthed' = FALSE
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               relayState, viewState, hintInFlight, lastHintSawView, probeResult,
               lastReconnectSource>>

\* RevokeDevice clears paired & tears down open WS; any upgrading socket fails recheck at WsUpstreamReady.
RevokeDevice ==
  /\ paired
  /\ paired' = FALSE
  /\ relayState' = "unpaired"
  /\ viewState' = "offline"
  /\ hintInFlight' = FALSE
  /\ lastHintSawView' = "none"
  /\ probeResult' = "none"
  /\ lastReconnectSource' = "none"
  /\ codeMintedAtGen' = -1
  /\ IF wsState = "open"
     THEN /\ wsState' = "closed"
          /\ wsOpenAuthed' = FALSE
     ELSE /\ UNCHANGED <<wsState, wsOpenAuthed>>
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, wsAdmittedAuthed>>

\* ---- Disconnect, Stale View Sync, Orthogonal Probe & Reconnect ----

TransportDrop ==
  /\ paired
  /\ relayState = "online"
  /\ relayState' = "offline"
  /\ probeResult' = "none"
  /\ lastReconnectSource' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired, viewState,
               hintInFlight, lastHintSawView, wsState, wsAdmittedAuthed, wsOpenAuthed>>

StatusPollSync ==
  /\ LET targetView == IF relayState = "online" THEN "online" ELSE "offline"
     IN /\ viewState /= targetView
        /\ viewState' = targetView
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               relayState, hintInFlight, lastHintSawView, probeResult,
               lastReconnectSource, wsState, wsAdmittedAuthed, wsOpenAuthed>>

HintSuppressedWhileOnline ==
  /\ paired
  /\ viewState = "online"
  /\ ~hintInFlight
  /\ UNCHANGED vars

\* sendNetworkHint() only checks snapshot.view?.state === 'online'; probeHealth() runs orthogonally
\* to relayState (can interleave with connecting/online/ManualRetry once row is not reloading).
SendNetworkHint ==
  /\ paired
  /\ wizardPhase /= "reloading"
  /\ viewState /= "online"
  /\ ~hintInFlight
  /\ hintInFlight' = TRUE
  /\ lastHintSawView' = viewState
  /\ probeResult' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               relayState, viewState, lastReconnectSource,
               wsState, wsAdmittedAuthed, wsOpenAuthed>>

\* probeHealth() completes with TRUE -> calls networkRestored() (which acts iff relayState = "offline").
\* probeHealth() completes with FALSE -> returns reachable:false, NEVER calls networkRestored().
CompleteProbe(ok) ==
  /\ hintInFlight
  /\ hintInFlight' = FALSE
  /\ lastHintSawView' = "none"
  /\ probeResult' = IF ok THEN "ok" ELSE "fail"
  /\ IF ok /\ paired /\ wizardPhase /= "reloading" /\ relayState = "offline"
     THEN /\ relayState' = "connecting"
          /\ lastReconnectSource' = IF ok THEN "probe_ok" ELSE "probe_fail"
     ELSE /\ UNCHANGED <<relayState, lastReconnectSource>>
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               viewState, wsState, wsAdmittedAuthed, wsOpenAuthed>>

ProbeSucceeds == CompleteProbe(TRUE)

ProbeFails == CompleteProbe(FALSE)

\* Manual reconnect (CLIENT_RECONNECT_ROUTE): only requires relayState = "offline", can interleave with hintInFlight.
ManualRetry ==
  /\ paired
  /\ wizardPhase /= "reloading"
  /\ relayState = "offline"
  /\ relayState' = "connecting"
  /\ probeResult' = "none"
  /\ lastReconnectSource' = "manual"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               viewState, hintInFlight, lastHintSawView,
               wsState, wsAdmittedAuthed, wsOpenAuthed>>

\* connect() succeeds -> relayState = "online" (viewState lags until StatusPollSync).
ConnectSucceeds ==
  /\ paired
  /\ relayState = "connecting"
  /\ relayState' = "online"
  /\ lastReconnectSource' = "none"
  /\ probeResult' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               viewState, hintInFlight, lastHintSawView,
               wsState, wsAdmittedAuthed, wsOpenAuthed>>

ConnectFails ==
  /\ paired
  /\ relayState = "connecting"
  /\ relayState' = "offline"
  /\ lastReconnectSource' = "none"
  /\ probeResult' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               viewState, hintInFlight, lastHintSawView,
               wsState, wsAdmittedAuthed, wsOpenAuthed>>

Next ==
  \/ WizardOpenWithoutRestart
  \/ WizardEditRestartField
  \/ CompleteRowReload
  \/ MintPairingCode
  \/ ClaimPairing
  \/ RejectUnauthWsUpgrade
  \/ WsUpgradeStart
  \/ WsUpstreamReady
  \/ RevokeDevice
  \/ TransportDrop
  \/ StatusPollSync
  \/ HintSuppressedWhileOnline
  \/ SendNetworkHint
  \/ ProbeSucceeds
  \/ ProbeFails
  \/ ManualRetry
  \/ ConnectSucceeds
  \/ ConnectFails

Spec == Init /\ [][Next]_vars

\* ---- Required Invariants (derived directly from real decision state, zero dead latches) ----

InvProbeFailNeverAutoReconnects ==
  /\ (relayState = "connecting" => lastReconnectSource \in {"probe_ok", "manual"})
  /\ lastReconnectSource /= "probe_fail"

InvHintGatedByOnlineView ==
  lastHintSawView /= "online"

InvPairingCodeOnlyAfterReload ==
  codeMintedAtGen /= -1 =>
    (wizardPhase = "ready" /\ rowGen = configGen /\ codeMintedAtGen = rowGen)

InvUnauthWsUpgradeRejected ==
  (wsState = "open") => (paired /\ wsOpenAuthed)
====
