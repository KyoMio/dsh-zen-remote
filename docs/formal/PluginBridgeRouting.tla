---- MODULE PluginBridgeRouting ----
(***************************************************************************)
(* Subsystem 2: Plugin Bridge Handshake & Route Forwarding (ZR-7)          *)
(*                                                                         *)
(* Faithful abstraction of:                                                *)
(*   - src/plugin-bridge.ts (createBridgeRegistry, compareBridges)         *)
(*   - src/plugin-adapter-core.ts (adapterOwnsRegistryEntry)               *)
(*   - src/index.ts (adapter yielding when plugin already registered)      *)
(*   - src/plugin-route-intercept.ts (surrogateHandler 503 unbridged wall) *)
(*   - src/plugin-tunnel.ts (WS upgrade 503 unbridged wall)                *)
(***************************************************************************)
EXTENDS TLC

ServerStates == {
  "offline",
  "missing",
  "match_v1_d1",
  "match_v2_d2",
  "bad_ver",
  "bad_digest",
  "consent_off"
}

BridgeStates == {
  "unregistered",
  "offline",
  "not_on_server",
  "version_mismatch",
  "declaration_mismatch",
  "consent_off",
  "bridged"
}

VARIABLES
  regOwner,              \* "none" | "adapter" | "plugin"
  regVer,                \* "none" | "v1" | "v2"
  regDigest,             \* "none" | "d1" | "d2"
  adapterHandleAlive,    \* TRUE if adapter's dispose closure has not yet fired
  pluginDeclared,        \* TRUE if plugin called zenRemote.bridge(...) and not disposed
  serverState,           \* ServerStates
  bridgeState,           \* BridgeStates derived by compareBridges
  lastReqKind,           \* "none" | "local" | "virtual"
  lastReqBridgeState,    \* bridgeState observed when lastReqKind was dispatched
  lastOutcome,           \* "none" | "local_handler" | "forwarded" | "refused_503"
  virtualFellBackToLocal \* ghost latch: TRUE if a virtual zr~ request ever hit local handler

vars == <<
  regOwner, regVer, regDigest, adapterHandleAlive, pluginDeclared,
  serverState, bridgeState, lastReqKind, lastReqBridgeState, lastOutcome,
  virtualFellBackToLocal
>>

ComputeBridge(owner, ver, dig, srv) ==
  IF owner = "none" THEN "unregistered"
  ELSE IF srv = "offline" THEN "offline"
  ELSE IF srv = "missing" THEN "not_on_server"
  ELSE IF srv = "bad_ver" THEN "version_mismatch"
  ELSE IF srv = "bad_digest" THEN "declaration_mismatch"
  ELSE IF srv = "consent_off" THEN "consent_off"
  ELSE IF (ver = "v1" /\ dig = "d1" /\ srv = "match_v1_d1")
       \/ (ver = "v2" /\ dig = "d2" /\ srv = "match_v2_d2") THEN "bridged"
  ELSE "version_mismatch"

TypeOK ==
  /\ regOwner \in {"none", "adapter", "plugin"}
  /\ regVer \in {"none", "v1", "v2"}
  /\ regDigest \in {"none", "d1", "d2"}
  /\ adapterHandleAlive \in BOOLEAN
  /\ pluginDeclared \in BOOLEAN
  /\ serverState \in ServerStates
  /\ bridgeState \in BridgeStates
  /\ lastReqKind \in {"none", "local", "virtual"}
  /\ lastReqBridgeState \in (BridgeStates \cup {"none"})
  /\ lastOutcome \in {"none", "local_handler", "forwarded", "refused_503"}
  /\ virtualFellBackToLocal \in BOOLEAN

Init ==
  /\ regOwner = "none"
  /\ regVer = "none"
  /\ regDigest = "none"
  /\ adapterHandleAlive = FALSE
  /\ pluginDeclared = FALSE
  /\ serverState = "offline"
  /\ bridgeState = "unregistered"
  /\ lastReqKind = "none"
  /\ lastReqBridgeState = "none"
  /\ lastOutcome = "none"
  /\ virtualFellBackToLocal = FALSE

\* ---- Registration & Adapter Precedence (src/index.ts, src/plugin-bridge.ts) ----

AdapterRegister ==
  /\ ~adapterHandleAlive
  /\ regOwner = "none"
  /\ regOwner' = "adapter"
  /\ regVer' = "v1"
  /\ regDigest' = "d1"
  /\ adapterHandleAlive' = TRUE
  /\ bridgeState' = ComputeBridge("adapter", "v1", "d1", serverState)
  /\ lastReqKind' = "none"
  /\ lastReqBridgeState' = "none"
  /\ lastOutcome' = "none"
  /\ UNCHANGED <<pluginDeclared, serverState, virtualFellBackToLocal>>

AdapterYieldsToPlugin ==
  /\ ~adapterHandleAlive
  /\ regOwner = "plugin"
  /\ UNCHANGED vars

PluginSelfRegister ==
  /\ ~pluginDeclared
  /\ pluginDeclared' = TRUE
  /\ regOwner' = "plugin"
  /\ regVer' = "v2"
  /\ regDigest' = "d2"
  /\ bridgeState' = ComputeBridge("plugin", "v2", "d2", serverState)
  /\ lastReqKind' = "none"
  /\ lastReqBridgeState' = "none"
  /\ lastOutcome' = "none"
  /\ UNCHANGED <<adapterHandleAlive, serverState, virtualFellBackToLocal>>

StaleAdapterDispose ==
  /\ adapterHandleAlive
  /\ regOwner = "plugin"
  /\ adapterHandleAlive' = FALSE
  /\ UNCHANGED <<regOwner, regVer, regDigest, pluginDeclared, serverState, bridgeState,
               lastReqKind, lastReqBridgeState, lastOutcome, virtualFellBackToLocal>>

ActiveAdapterDispose ==
  /\ adapterHandleAlive
  /\ regOwner = "adapter"
  /\ adapterHandleAlive' = FALSE
  /\ regOwner' = "none"
  /\ regVer' = "none"
  /\ regDigest' = "none"
  /\ bridgeState' = "unregistered"
  /\ lastReqKind' = "none"
  /\ lastReqBridgeState' = "none"
  /\ lastOutcome' = "none"
  /\ UNCHANGED <<pluginDeclared, serverState, virtualFellBackToLocal>>

PluginDispose ==
  /\ pluginDeclared
  /\ regOwner = "plugin"
  /\ pluginDeclared' = FALSE
  /\ regOwner' = "none"
  /\ regVer' = "none"
  /\ regDigest' = "none"
  /\ bridgeState' = "unregistered"
  /\ lastReqKind' = "none"
  /\ lastReqBridgeState' = "none"
  /\ lastOutcome' = "none"
  /\ UNCHANGED <<adapterHandleAlive, serverState, virtualFellBackToLocal>>

\* ---- Server Handshake / Verdict Transitions ----

HandshakeSync(srv) ==
  /\ srv \in ServerStates
  /\ srv /= serverState
  /\ serverState' = srv
  /\ bridgeState' = ComputeBridge(regOwner, regVer, regDigest, srv)
  /\ lastReqKind' = "none"
  /\ lastReqBridgeState' = "none"
  /\ lastOutcome' = "none"
  /\ UNCHANGED <<regOwner, regVer, regDigest, adapterHandleAlive, pluginDeclared,
               virtualFellBackToLocal>>

\* ---- Route Interception (src/plugin-route-intercept.ts, src/plugin-tunnel.ts) ----

HandleVirtualRequest ==
  /\ regOwner /= "none"
  /\ lastReqKind' = "virtual"
  /\ lastReqBridgeState' = bridgeState
  /\ lastOutcome' = IF bridgeState = "bridged" THEN "forwarded" ELSE "refused_503"
  /\ UNCHANGED <<regOwner, regVer, regDigest, adapterHandleAlive, pluginDeclared,
               serverState, bridgeState, virtualFellBackToLocal>>

HandleLocalRequest ==
  /\ regOwner /= "none"
  /\ lastReqKind' = "local"
  /\ lastReqBridgeState' = bridgeState
  /\ lastOutcome' = "local_handler"
  /\ UNCHANGED <<regOwner, regVer, regDigest, adapterHandleAlive, pluginDeclared,
               serverState, bridgeState, virtualFellBackToLocal>>

Next ==
  \/ AdapterRegister
  \/ AdapterYieldsToPlugin
  \/ PluginSelfRegister
  \/ StaleAdapterDispose
  \/ ActiveAdapterDispose
  \/ PluginDispose
  \/ \E srv \in ServerStates : HandshakeSync(srv)
  \/ HandleVirtualRequest
  \/ HandleLocalRequest

Spec == Init /\ [][Next]_vars

\* ---- Required Invariants ----

InvBridgedRequiresExactTriplet ==
  bridgeState = "bridged" =>
    /\ regOwner /= "none"
    /\ \/ (regVer = "v1" /\ regDigest = "d1" /\ serverState = "match_v1_d1")
       \/ (regVer = "v2" /\ regDigest = "d2" /\ serverState = "match_v2_d2")

InvNonBridgedVirtualAlways503 ==
  /\ ~virtualFellBackToLocal
  /\ (lastReqKind = "virtual" => lastOutcome /= "local_handler")
  /\ ((lastReqKind = "virtual" /\ lastReqBridgeState /= "bridged") => lastOutcome = "refused_503")

InvPluginSelfDeclOverridesAdapter ==
  pluginDeclared => (regOwner = "plugin" /\ regVer = "v2" /\ regDigest = "d2")
====
