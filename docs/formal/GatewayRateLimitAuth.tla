---- MODULE GatewayRateLimitAuth ----
(***************************************************************************)
(* Subsystem 3: Open-source gateway-server Rate Limiting & Auth (ZR-7 R2)  *)
(*                                                                         *)
(* Faithful abstraction of:                                                *)
(*   - gateway-server/src/peer-hub/ws-hub.ts                               *)
(*       resolvePreAuthClientIp (trustedProxies + x-real-ip only)          *)
(*       setupConnection (maxPreAuthSockets, maxPreAuthPerIp -> 1013)      *)
(*   - gateway-server/src/http/auth.ts                                     *)
(*       requireAdmin (Bearer API key priority, never falls back to Cookie)*)
(*       requireUser / handleMe / handleLogout (Cookie only -> Finding #1) *)
(*       handleSendOtp / handleResetPassword (Finding #2)                  *)
(*       requestIsHttps / requestClientIp (Gap #3a / #3b)                  *)
(*   - gateway-server/src/server.ts (isBearerAdminApi CSRF boundary)       *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS MaxPreAuthPerIp, MaxPreAuthGlobal

ASSUME MaxPreAuthPerIp = 1 /\ MaxPreAuthGlobal = 2

WsDecisions == {"idle", "accepted", "rejected_1013"}
BucketKinds == {"none", "direct", "proxied"}
RouteKinds == {"none", "admin", "user"}
BearerKinds == {"none", "valid_key", "bad_key"}
AuthActors == {"none", "api_admin", "cookie_admin", "cookie_user", "rejected_401"}
HttpSurfaces == {"none", "bearer_api", "cookie_issue", "ratelimit_user"}
HttpIpResults == {"none", "socket", "real_ip"}
OtpPurposes == {"none", "signup", "reset_password"}
Roles == {"none", "user", "admin"}

VARIABLES
  preAuthDirect,     \* pre-auth WS slots held by untrusted socketIp
  preAuthProxiedA,   \* pre-auth WS slots via trusted proxy for client A
  preAuthProxiedB,   \* pre-auth WS slots via trusted proxy for client B
  wsDecision,        \* latest WS pre-auth decision
  wsReqFromTrusted,  \* whether latest WS connection socketIp \in trustedProxies
  wsResolvedKind,    \* "none" | "direct" | "proxied" from ResolvePreAuthIp
  reqRouteKind,      \* latest HTTP route class ("admin" | "user" | "none")
  reqBearerKind,     \* latest HTTP Bearer header kind
  reqHasCookie,      \* whether latest HTTP request also carried a Cookie
  authActor,         \* resolved identity for latest HTTP request
  httpSurface,       \* which HTTP proxy-sensitive surface was exercised
  httpFromTrusted,   \* whether HTTP socketIp \in trustedProxies
  httpIsHttps,       \* output of ResolveHttpIsHttps (requestIsHttps)
  httpClientIp,      \* output of ResolveHttpClientIp (requestClientIp)
  otpPurpose,        \* latest OTP flow purpose
  otpTargetRole,     \* target account role for latest OTP flow
  otpDelivered,      \* whether OTP email was delivered
  otpMintedSession   \* whether OTP flow issued a session Cookie

vars == <<
  preAuthDirect, preAuthProxiedA, preAuthProxiedB,
  wsDecision, wsReqFromTrusted, wsResolvedKind,
  reqRouteKind, reqBearerKind, reqHasCookie, authActor,
  httpSurface, httpFromTrusted, httpIsHttps, httpClientIp,
  otpPurpose, otpTargetRole, otpDelivered, otpMintedSession
>>

TotalPreAuth == preAuthDirect + preAuthProxiedA + preAuthProxiedB

\* Models ws-hub.ts:319-331 (resolvePreAuthClientIp): adopts X-Real-IP iff socketIp \in trustedProxies.
ResolvePreAuthIp(fromTrusted, claimed) ==
  IF fromTrusted THEN claimed ELSE "direct"

\* Models auth.ts:367-423 (requireAdmin vs requireUser/handleMe/handleLogout).
AuthorizeHttp(routeKind, bearerKind, hasCookie) ==
  IF routeKind = "admin"
  THEN IF bearerKind = "valid_key" THEN "api_admin"
       ELSE IF bearerKind = "bad_key" THEN "rejected_401"
       ELSE IF hasCookie THEN "cookie_admin"
       ELSE "rejected_401"
  ELSE IF hasCookie THEN "cookie_user"
  ELSE "rejected_401"

\* Models auth.ts:317-330 (requestIsHttps): trusts x-forwarded-proto regardless of trustedProxies.
ResolveHttpIsHttps(fromTrusted, hasXfpHttps) == hasXfpHttps

\* Models auth.ts:475-477 (requestClientIp): ignores trustedProxies, always uses socket.remoteAddress.
ResolveHttpClientIp(fromTrusted, hasRealIp) == "socket"

TypeOK ==
  /\ preAuthDirect \in 0..MaxPreAuthPerIp
  /\ preAuthProxiedA \in 0..MaxPreAuthPerIp
  /\ preAuthProxiedB \in 0..MaxPreAuthPerIp
  /\ TotalPreAuth <= MaxPreAuthGlobal
  /\ wsDecision \in WsDecisions
  /\ wsReqFromTrusted \in BOOLEAN
  /\ wsResolvedKind \in BucketKinds
  /\ reqRouteKind \in RouteKinds
  /\ reqBearerKind \in BearerKinds
  /\ reqHasCookie \in BOOLEAN
  /\ authActor \in AuthActors
  /\ httpSurface \in HttpSurfaces
  /\ httpFromTrusted \in BOOLEAN
  /\ httpIsHttps \in BOOLEAN
  /\ httpClientIp \in HttpIpResults
  /\ otpPurpose \in OtpPurposes
  /\ otpTargetRole \in Roles
  /\ otpDelivered \in BOOLEAN
  /\ otpMintedSession \in BOOLEAN

Init ==
  /\ preAuthDirect = 0
  /\ preAuthProxiedA = 0
  /\ preAuthProxiedB = 0
  /\ wsDecision = "idle"
  /\ wsReqFromTrusted = FALSE
  /\ wsResolvedKind = "none"
  /\ reqRouteKind = "none"
  /\ reqBearerKind = "none"
  /\ reqHasCookie = FALSE
  /\ authActor = "none"
  /\ httpSurface = "none"
  /\ httpFromTrusted = FALSE
  /\ httpIsHttps = FALSE
  /\ httpClientIp = "none"
  /\ otpPurpose = "none"
  /\ otpTargetRole = "none"
  /\ otpDelivered = FALSE
  /\ otpMintedSession = FALSE

\* ---- WS Pre-Auth IP Resolution & 1013 Cap (ws-hub.ts:319-331, 676-685) ----

WsConnect(fromTrusted, claimed) ==
  LET bucket == ResolvePreAuthIp(fromTrusted, claimed)
      bucketCount == IF bucket = "direct" THEN preAuthDirect
                     ELSE IF bucket = "A" THEN preAuthProxiedA
                     ELSE preAuthProxiedB
  IN /\ wsReqFromTrusted' = fromTrusted
     /\ wsResolvedKind' = IF bucket = "direct" THEN "direct" ELSE "proxied"
     /\ IF TotalPreAuth >= MaxPreAuthGlobal \/ bucketCount >= MaxPreAuthPerIp
        THEN /\ wsDecision' = "rejected_1013"
             /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB>>
        ELSE /\ wsDecision' = "accepted"
             /\ preAuthDirect' = IF bucket = "direct" THEN preAuthDirect + 1 ELSE preAuthDirect
             /\ preAuthProxiedA' = IF bucket = "A" THEN preAuthProxiedA + 1 ELSE preAuthProxiedA
             /\ preAuthProxiedB' = IF bucket = "B" THEN preAuthProxiedB + 1 ELSE preAuthProxiedB
     /\ UNCHANGED <<reqRouteKind, reqBearerKind, reqHasCookie, authActor,
                  httpSurface, httpFromTrusted, httpIsHttps, httpClientIp,
                  otpPurpose, otpTargetRole, otpDelivered, otpMintedSession>>

WsConnectUntrusted == WsConnect(FALSE, "A")

WsConnectTrustedProxy ==
  \E claimed \in {"A", "B"} : WsConnect(TRUE, claimed)

WsReleasePreAuth ==
  /\ \/ /\ preAuthDirect > 0
        /\ preAuthDirect' = preAuthDirect - 1
        /\ UNCHANGED <<preAuthProxiedA, preAuthProxiedB>>
     \/ /\ preAuthProxiedA > 0
        /\ preAuthProxiedA' = preAuthProxiedA - 1
        /\ UNCHANGED <<preAuthDirect, preAuthProxiedB>>
     \/ /\ preAuthProxiedB > 0
        /\ preAuthProxiedB' = preAuthProxiedB - 1
        /\ UNCHANGED <<preAuthDirect, preAuthProxiedA>>
  /\ wsDecision' = "idle"
  /\ wsReqFromTrusted' = FALSE
  /\ wsResolvedKind' = "none"
  /\ UNCHANGED <<reqRouteKind, reqBearerKind, reqHasCookie, authActor,
               httpSurface, httpFromTrusted, httpIsHttps, httpClientIp,
               otpPurpose, otpTargetRole, otpDelivered, otpMintedSession>>

\* ---- HTTP Dual-Track Auth + HTTP Proxy Header Boundaries ----

HttpAuthCase(routeKind, bearerKind, hasCookie, surface, fromTrusted, hasXfp, hasRealIp) ==
  /\ reqRouteKind = "none"
  /\ reqRouteKind' = routeKind
  /\ reqBearerKind' = bearerKind
  /\ reqHasCookie' = hasCookie
  /\ authActor' = AuthorizeHttp(routeKind, bearerKind, hasCookie)
  /\ httpSurface' = surface
  /\ httpFromTrusted' = fromTrusted
  /\ httpIsHttps' = IF surface = "cookie_issue" THEN ResolveHttpIsHttps(fromTrusted, hasXfp) ELSE FALSE
  /\ httpClientIp' = IF surface = "ratelimit_user" THEN ResolveHttpClientIp(fromTrusted, hasRealIp) ELSE "none"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB,
               wsDecision, wsReqFromTrusted, wsResolvedKind,
               otpPurpose, otpTargetRole, otpDelivered, otpMintedSession>>

HttpAuthRequest ==
  \/ HttpAuthCase("admin", "valid_key", TRUE, "bearer_api", TRUE, FALSE, FALSE)
  \/ HttpAuthCase("admin", "bad_key", TRUE, "bearer_api", FALSE, FALSE, FALSE)
  \/ HttpAuthCase("admin", "none", TRUE, "cookie_issue", FALSE, TRUE, FALSE)
  \/ HttpAuthCase("user", "valid_key", TRUE, "ratelimit_user", TRUE, FALSE, TRUE)

HttpAuthDone ==
  /\ reqRouteKind /= "none"
  /\ reqRouteKind' = "none"
  /\ reqBearerKind' = "none"
  /\ reqHasCookie' = FALSE
  /\ authActor' = "none"
  /\ httpSurface' = "none"
  /\ httpFromTrusted' = FALSE
  /\ httpIsHttps' = FALSE
  /\ httpClientIp' = "none"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB,
               wsDecision, wsReqFromTrusted, wsResolvedKind,
               otpPurpose, otpTargetRole, otpDelivered, otpMintedSession>>

\* ---- OTP Issuance & Session Creation (auth.ts:914-969, 997-1076) ----

OtpCase(purpose, targetRole) ==
  /\ otpPurpose = "none"
  /\ otpPurpose' = purpose
  /\ otpTargetRole' = targetRole
  /\ otpDelivered' = (purpose = "reset_password" \/ targetRole = "user")
  /\ otpMintedSession' = (purpose = "signup" /\ targetRole = "user")
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB,
               wsDecision, wsReqFromTrusted, wsResolvedKind,
               reqRouteKind, reqBearerKind, reqHasCookie, authActor,
               httpSurface, httpFromTrusted, httpIsHttps, httpClientIp>>

OtpRequest ==
  \/ OtpCase("signup", "admin")
  \/ OtpCase("reset_password", "admin")
  \/ OtpCase("signup", "user")

OtpReqDone ==
  /\ otpPurpose /= "none"
  /\ otpPurpose' = "none"
  /\ otpTargetRole' = "none"
  /\ otpDelivered' = FALSE
  /\ otpMintedSession' = FALSE
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB,
               wsDecision, wsReqFromTrusted, wsResolvedKind,
               reqRouteKind, reqBearerKind, reqHasCookie, authActor,
               httpSurface, httpFromTrusted, httpIsHttps, httpClientIp>>

Next ==
  \/ WsConnectUntrusted
  \/ WsConnectTrustedProxy
  \/ WsReleasePreAuth
  \/ HttpAuthRequest
  \/ HttpAuthDone
  \/ OtpRequest
  \/ OtpReqDone

Spec == Init /\ [][Next]_vars

\* ---- Code-Held Invariants (computed from real inputs/decisions, 0 counterexamples) ----

InvTrustedProxyHeaderGate ==
  (~wsReqFromTrusted /\ wsResolvedKind /= "none") => (wsResolvedKind = "direct")

InvPreAuthLimitsBounded ==
  /\ preAuthDirect <= MaxPreAuthPerIp
  /\ preAuthProxiedA <= MaxPreAuthPerIp
  /\ preAuthProxiedB <= MaxPreAuthPerIp
  /\ TotalPreAuth <= MaxPreAuthGlobal

InvAdminBearerNeverFallsBackToCookie ==
  /\ (reqRouteKind = "admin" /\ reqBearerKind /= "none") =>
       (authActor /= "cookie_admin" /\ authActor /= "cookie_user")
  /\ (reqRouteKind = "admin" /\ reqBearerKind = "bad_key") => (authActor = "rejected_401")

InvAdminNeverIssuedOtpSession ==
  (otpTargetRole = "admin") => ~otpMintedSession

\* ---- Stricter Target Invariants (Finding Probes: expose real open-source gaps) ----

InvAllRoutesBearerOverridesCookie ==
  (reqBearerKind /= "none") => (authActor /= "cookie_user" /\ authActor /= "cookie_admin")

InvAdminRefusedAllOtpDelivery ==
  (otpTargetRole = "admin") => ~otpDelivered

InvHttpProxyTrustConsistent ==
  /\ (httpSurface = "cookie_issue" /\ ~httpFromTrusted) => ~httpIsHttps
  /\ (httpSurface = "ratelimit_user" /\ httpFromTrusted) => (httpClientIp = "real_ip")
====
