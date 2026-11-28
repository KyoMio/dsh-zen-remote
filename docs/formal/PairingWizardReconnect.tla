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
(*   - src/relay-client.ts (probeHealth, networkRestored, reconnect)       *)
(*   - lib/lan-gate-server.cjs (server.on('upgrade') auth + revoke wall)   *)
(***************************************************************************)
EXTENDS Integers, TLC

VARIABLES
  configGen,                   \* 0 = initial config, 1 = wizard edited a RESTART_FIELDS entry
  rowGen,                      \* generation currently running in the reloaded plugin row
  wizardPhase,                 \* "idle" | "reloading" | "ready"
  codeMintedAtGen,             \* -1 if no pairing code minted, else rowGen at mint time
  paired,                      \* TRUE after ClaimPairing succeeds, FALSE before or after RevokeDevice
  relayState,                  \* "unpaired" | "offline" | "probing" | "connecting" | "online"
  viewState,                   \* "offline" | "online" (UI snapshot.view?.state, can lag behind relayState)
  hintDispatched,              \* TRUE while a network-hint probeHealth() round-trip is in flight
  probeOutcome,                \* "none" | "ok" | "fail"
  lastReconnectSource,         \* "none" | "probe_ok" | "manual" | "probe_fail"
  wsAdmitted,                  \* TRUE if a remote WebSocket upgrade is currently open
  hintSentWhileViewOnline,     \* ghost latch: TRUE if hint ever bypassed viewState="online" gate
  reconnectTriggeredByProbeFail, \* ghost latch: TRUE if probe fail ever triggered reconnect
  wsAdmittedWithoutAuth        \* ghost latch: TRUE if WS upgrade admitted without paired auth

vars == <<
  configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
  relayState, viewState, hintDispatched, probeOutcome, lastReconnectSource,
  wsAdmitted, hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth
>>

TypeOK ==
  /\ configGen \in {0, 1}
  /\ rowGen \in {0, 1}
  /\ wizardPhase \in {"idle", "reloading", "ready"}
  /\ codeMintedAtGen \in {-1, 0, 1}
  /\ paired \in BOOLEAN
  /\ relayState \in {"unpaired", "offline", "probing", "connecting", "online"}
  /\ viewState \in {"offline", "online"}
  /\ hintDispatched \in BOOLEAN
  /\ probeOutcome \in {"none", "ok", "fail"}
  /\ lastReconnectSource \in {"none", "probe_ok", "manual", "probe_fail"}
  /\ wsAdmitted \in BOOLEAN
  /\ hintSentWhileViewOnline \in BOOLEAN
  /\ reconnectTriggeredByProbeFail \in BOOLEAN
  /\ wsAdmittedWithoutAuth \in BOOLEAN

Init ==
  /\ configGen = 0
  /\ rowGen = 0
  /\ wizardPhase = "idle"
  /\ codeMintedAtGen = -1
  /\ paired = FALSE
  /\ relayState = "unpaired"
  /\ viewState = "offline"
  /\ hintDispatched = FALSE
  /\ probeOutcome = "none"
  /\ lastReconnectSource = "none"
  /\ wsAdmitted = FALSE
  /\ hintSentWhileViewOnline = FALSE
  /\ reconnectTriggeredByProbeFail = FALSE
  /\ wsAdmittedWithoutAuth = FALSE

\* ---- Wizard & Row Reload ----

\* Start wizard without changing any RESTART_FIELDS entry (rowGen == configGen already).
WizardOpenWithoutRestart ==
  /\ wizardPhase = "idle"
  /\ rowGen = configGen
  /\ wizardPhase' = "ready"
  /\ UNCHANGED <<configGen, rowGen, codeMintedAtGen, paired, relayState, viewState,
               hintDispatched, probeOutcome, lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* Edit a RESTART_FIELDS entry (e.g. host / trustedProxies) -> startRestartWatcher triggers reload.
\* Invalidates any previously minted pairing code (verificationFingerprint drift -> stale).
WizardEditRestartField ==
  /\ wizardPhase \in {"idle", "ready"}
  /\ configGen = 0
  /\ ~paired
  /\ configGen' = 1
  /\ wizardPhase' = "reloading"
  /\ codeMintedAtGen' = -1
  /\ UNCHANGED <<rowGen, paired, relayState, viewState, hintDispatched, probeOutcome,
               lastReconnectSource, wsAdmitted, hintSentWhileViewOnline,
               reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* fiber.restart() finishes and new gateway child binds its port.
CompleteRowReload ==
  /\ wizardPhase = "reloading"
  /\ rowGen < configGen
  /\ rowGen' = configGen
  /\ wizardPhase' = "ready"
  /\ UNCHANGED <<configGen, codeMintedAtGen, paired, relayState, viewState,
               hintDispatched, probeOutcome, lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* createVerificationManager().start() mints pairingCode only once wizardPhase="ready" and rowGen=configGen.
MintPairingCode ==
  /\ wizardPhase = "ready"
  /\ rowGen = configGen
  /\ codeMintedAtGen = -1
  /\ ~paired
  /\ codeMintedAtGen' = rowGen
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, paired, relayState, viewState,
               hintDispatched, probeOutcome, lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* Device redeems the pairing code minted for the current row generation.
ClaimPairing ==
  /\ codeMintedAtGen = rowGen
  /\ ~paired
  /\ paired' = TRUE
  /\ relayState' = "online"
  /\ viewState' = "online"
  /\ probeOutcome' = "none"
  /\ lastReconnectSource' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, hintDispatched, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* ---- WebSocket Upgrade Gate (lib/lan-gate-server.cjs:1450-1506) ----

\* Unauthenticated remote WS upgrade is always rejected (403 Forbidden).
RejectUnauthWsUpgrade ==
  /\ ~paired
  /\ ~wsAdmitted
  /\ UNCHANGED vars

\* Authenticated WS upgrade admitted only while paired and relay is online.
AdmitAuthWsUpgrade ==
  /\ paired
  /\ relayState = "online"
  /\ ~wsAdmitted
  /\ wsAdmitted' = TRUE
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               relayState, viewState, hintDispatched, probeOutcome, lastReconnectSource,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* Revoking the device drops WS sockets, resets relay to unpaired, and clears pairing state.
RevokeDevice ==
  /\ paired
  /\ paired' = FALSE
  /\ wsAdmitted' = FALSE
  /\ relayState' = "unpaired"
  /\ viewState' = "offline"
  /\ hintDispatched' = FALSE
  /\ probeOutcome' = "none"
  /\ lastReconnectSource' = "none"
  /\ codeMintedAtGen' = -1
  /\ UNCHANGED <<configGen, rowGen, wizardPhase,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* ---- Disconnect, Stale View Sync, Hint Gate, Probe & Reconnect ----

\* Transport drops: relay becomes offline, WS closes, viewState stays stale "online" until poll syncs.
TransportDrop ==
  /\ paired
  /\ relayState = "online"
  /\ relayState' = "offline"
  /\ wsAdmitted' = FALSE
  /\ probeOutcome' = "none"
  /\ lastReconnectSource' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired, viewState,
               hintDispatched, hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* RemoteStatusStore polling updates snapshot.view?.state to match relayState.
StatusPollSync ==
  /\ paired
  /\ LET targetView == IF relayState = "online" THEN "online" ELSE "offline"
     IN /\ viewState /= targetView
        /\ viewState' = targetView
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               relayState, hintDispatched, probeOutcome, lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* Browser fires network hint while snapshot.view?.state === "online" -> gated (suppressed).
HintSuppressedWhileOnline ==
  /\ paired
  /\ viewState = "online"
  /\ ~hintDispatched
  /\ UNCHANGED vars

\* Browser fires network hint after snapshot.view?.state is "offline" -> runs probeHealth().
NetworkHintSend ==
  /\ paired
  /\ viewState /= "online"
  /\ ~hintDispatched
  /\ relayState = "offline"
  /\ hintDispatched' = TRUE
  /\ relayState' = "probing"
  /\ probeOutcome' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired, viewState,
               lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* GET /ping succeeds -> networkRestored() enters connecting.
ProbeSucceedsAndRestores ==
  /\ paired
  /\ relayState = "probing"
  /\ hintDispatched
  /\ probeOutcome' = "ok"
  /\ hintDispatched' = FALSE
  /\ relayState' = "connecting"
  /\ lastReconnectSource' = "probe_ok"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired, viewState, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* GET /ping fails -> returns { reachable: false, reconnected: false }, stays offline (never auto-reconnects).
ProbeFailsNoReconnect ==
  /\ paired
  /\ relayState = "probing"
  /\ hintDispatched
  /\ probeOutcome' = "fail"
  /\ hintDispatched' = FALSE
  /\ relayState' = "offline"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired, viewState,
               lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* Manual reconnect button (POST client/reconnect) while offline.
ManualRetry ==
  /\ paired
  /\ relayState = "offline"
  /\ ~hintDispatched
  /\ relayState' = "connecting"
  /\ probeOutcome' = "none"
  /\ lastReconnectSource' = "manual"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired, viewState,
               hintDispatched, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* connect() succeeds -> online, syncs view.
ConnectSucceeds ==
  /\ paired
  /\ relayState = "connecting"
  /\ relayState' = "online"
  /\ viewState' = "online"
  /\ probeOutcome' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired,
               hintDispatched, lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

\* connect() fails -> returns to offline.
ConnectFails ==
  /\ paired
  /\ relayState = "connecting"
  /\ relayState' = "offline"
  /\ probeOutcome' = "none"
  /\ UNCHANGED <<configGen, rowGen, wizardPhase, codeMintedAtGen, paired, viewState,
               hintDispatched, lastReconnectSource, wsAdmitted,
               hintSentWhileViewOnline, reconnectTriggeredByProbeFail, wsAdmittedWithoutAuth>>

Next ==
  \/ WizardOpenWithoutRestart
  \/ WizardEditRestartField
  \/ CompleteRowReload
  \/ MintPairingCode
  \/ ClaimPairing
  \/ RejectUnauthWsUpgrade
  \/ AdmitAuthWsUpgrade
  \/ RevokeDevice
  \/ TransportDrop
  \/ StatusPollSync
  \/ HintSuppressedWhileOnline
  \/ NetworkHintSend
  \/ ProbeSucceedsAndRestores
  \/ ProbeFailsNoReconnect
  \/ ManualRetry
  \/ ConnectSucceeds
  \/ ConnectFails

Spec == Init /\ [][Next]_vars

\* ---- Required Invariants ----

InvProbeFailNeverAutoReconnects ==
  /\ ~reconnectTriggeredByProbeFail
  /\ (probeOutcome = "fail" => relayState /= "connecting")
  /\ (relayState = "connecting" => lastReconnectSource /= "probe_fail")

InvHintGatedByOnlineView ==
  ~hintSentWhileViewOnline

InvPairingCodeOnlyAfterReload ==
  codeMintedAtGen /= -1 =>
    (wizardPhase = "ready" /\ rowGen = configGen /\ codeMintedAtGen = rowGen)

InvUnauthWsUpgradeRejected ==
  /\ ~wsAdmittedWithoutAuth
  /\ (wsAdmitted => paired)
====
