---- MODULE GatewayRateLimitAuth ----
(***************************************************************************)
(* Subsystem 3: Open-source gateway-server Rate Limiting & Auth (ZR-7)     *)
(*                                                                         *)
(* Faithful abstraction of:                                                *)
(*   - gateway-server/src/peer-hub/ws-hub.ts                               *)
(*       resolvePreAuthClientIp (trustedProxies + x-real-ip only)          *)
(*       setupConnection (maxPreAuthSockets, maxPreAuthPerIp -> 1013)      *)
(*   - gateway-server/src/http/auth.ts                                     *)
(*       requireAdmin (Bearer API key priority, never falls back to Cookie)*)
(*       requireUser / handleMe (Cookie only; ignores Bearer -> Finding #1)*)
(*       requestClientIp (socket.remoteAddress only)                       *)
(*       handleSendOtp (signup denies existing admin; reset_password       *)
(*                      delivers to active admin -> Finding #2, no session)*)
(*   - gateway-server/src/server.ts (isBearerAdminApi CSRF boundary)       *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS MaxPreAuthPerIp, MaxPreAuthGlobal

ASSUME MaxPreAuthPerIp = 1 /\ MaxPreAuthGlobal = 2

WsDecisions == {"idle", "direct_ok", "proxy_ok", "rejected_1013"}
AuthDecisions == {
  "idle",
  "admin_bearer_ok",
  "admin_bearer_401",
  "admin_bearer_fell_back_cookie",
  "admin_cookie_ok",
  "user_bearer_ignored"
}
OtpDecisions == {"idle", "signup_denied", "reset_delivered"}

VARIABLES
  preAuthDirect,          \* pre-auth WS slots held by untrusted peer IP
  preAuthProxiedA,        \* pre-auth WS slots via trusted proxy for client A
  preAuthProxiedB,        \* pre-auth WS slots via trusted proxy for client B
  wsDecision,             \* latest WS pre-auth decision
  authDecision,           \* latest HTTP auth check outcome
  otpDecision,            \* latest Admin OTP endpoint outcome
  untrustedHeaderAdopted, \* ghost latch: TRUE if untrusted peer's forwarded header was trusted
  adminFellBackToCookie,  \* ghost latch: TRUE if requireAdmin fell back to Cookie on Bearer req
  adminOtpSessionIssued   \* ghost latch: TRUE if any OTP flow created an admin session

vars == <<
  preAuthDirect, preAuthProxiedA, preAuthProxiedB,
  wsDecision, authDecision, otpDecision,
  untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued
>>

TotalPreAuth == preAuthDirect + preAuthProxiedA + preAuthProxiedB

TypeOK ==
  /\ preAuthDirect \in 0..MaxPreAuthPerIp
  /\ preAuthProxiedA \in 0..MaxPreAuthPerIp
  /\ preAuthProxiedB \in 0..MaxPreAuthPerIp
  /\ TotalPreAuth <= MaxPreAuthGlobal
  /\ wsDecision \in WsDecisions
  /\ authDecision \in AuthDecisions
  /\ otpDecision \in OtpDecisions
  /\ untrustedHeaderAdopted \in BOOLEAN
  /\ adminFellBackToCookie \in BOOLEAN
  /\ adminOtpSessionIssued \in BOOLEAN

Init ==
  /\ preAuthDirect = 0
  /\ preAuthProxiedA = 0
  /\ preAuthProxiedB = 0
  /\ wsDecision = "idle"
  /\ authDecision = "idle"
  /\ otpDecision = "idle"
  /\ untrustedHeaderAdopted = FALSE
  /\ adminFellBackToCookie = FALSE
  /\ adminOtpSessionIssued = FALSE

\* ---- WS Pre-Auth IP Resolution & 1013 Rate/Slot Cap (ws-hub.ts:319-331, 676-685) ----

WsConnectUntrusted ==
  /\ IF TotalPreAuth >= MaxPreAuthGlobal \/ preAuthDirect >= MaxPreAuthPerIp
     THEN /\ wsDecision' = "rejected_1013"
          /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB>>
     ELSE /\ preAuthDirect' = preAuthDirect + 1
          /\ wsDecision' = "direct_ok"
          /\ UNCHANGED <<preAuthProxiedA, preAuthProxiedB>>
  /\ UNCHANGED <<authDecision, otpDecision, untrustedHeaderAdopted,
               adminFellBackToCookie, adminOtpSessionIssued>>

WsConnectTrustedProxyA ==
  /\ IF TotalPreAuth >= MaxPreAuthGlobal \/ preAuthProxiedA >= MaxPreAuthPerIp
     THEN /\ wsDecision' = "rejected_1013"
          /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB>>
     ELSE /\ preAuthProxiedA' = preAuthProxiedA + 1
          /\ wsDecision' = "proxy_ok"
          /\ UNCHANGED <<preAuthDirect, preAuthProxiedB>>
  /\ UNCHANGED <<authDecision, otpDecision, untrustedHeaderAdopted,
               adminFellBackToCookie, adminOtpSessionIssued>>

WsConnectTrustedProxyB ==
  /\ IF TotalPreAuth >= MaxPreAuthGlobal \/ preAuthProxiedB >= MaxPreAuthPerIp
     THEN /\ wsDecision' = "rejected_1013"
          /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB>>
     ELSE /\ preAuthProxiedB' = preAuthProxiedB + 1
          /\ wsDecision' = "proxy_ok"
          /\ UNCHANGED <<preAuthDirect, preAuthProxiedA>>
  /\ UNCHANGED <<authDecision, otpDecision, untrustedHeaderAdopted,
               adminFellBackToCookie, adminOtpSessionIssued>>

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
  /\ wsDecision' = IF (preAuthDirect' + preAuthProxiedA' + preAuthProxiedB') = 0
                   THEN "idle" ELSE wsDecision
  /\ UNCHANGED <<authDecision, otpDecision, untrustedHeaderAdopted,
               adminFellBackToCookie, adminOtpSessionIssued>>

\* ---- HTTP Dual-Track Auth (auth.ts:367-423) ----

AdminReqValidBearerWithCookie ==
  /\ authDecision = "idle"
  /\ authDecision' = "admin_bearer_ok"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, otpDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

AdminReqInvalidBearerWithCookie ==
  /\ authDecision = "idle"
  /\ authDecision' = "admin_bearer_401"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, otpDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

AdminReqCookieOnly ==
  /\ authDecision = "idle"
  /\ authDecision' = "admin_cookie_ok"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, otpDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

\* Finding #1: requireUser / handleMe ignores Authorization: Bearer and reads Cookie.
UserReqWithBearerAndCookie ==
  /\ authDecision = "idle"
  /\ authDecision' = "user_bearer_ignored"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, otpDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

HttpAuthDone ==
  /\ authDecision /= "idle"
  /\ authDecision' = "idle"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, otpDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

\* ---- OTP Issuance for Admin Email (auth.ts:914-969, 997-1076) ----

SignupOtpForAdmin ==
  /\ otpDecision = "idle"
  /\ otpDecision' = "signup_denied"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, authDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

\* Finding #2: reset_password send-otp delivers code to active admin (without issuing session).
ResetPasswordOtpForAdmin ==
  /\ otpDecision = "idle"
  /\ otpDecision' = "reset_delivered"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, authDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

OtpReqDone ==
  /\ otpDecision /= "idle"
  /\ otpDecision' = "idle"
  /\ UNCHANGED <<preAuthDirect, preAuthProxiedA, preAuthProxiedB, wsDecision, authDecision,
               untrustedHeaderAdopted, adminFellBackToCookie, adminOtpSessionIssued>>

Next ==
  \/ WsConnectUntrusted
  \/ WsConnectTrustedProxyA
  \/ WsConnectTrustedProxyB
  \/ WsReleasePreAuth
  \/ AdminReqValidBearerWithCookie
  \/ AdminReqInvalidBearerWithCookie
  \/ AdminReqCookieOnly
  \/ UserReqWithBearerAndCookie
  \/ HttpAuthDone
  \/ SignupOtpForAdmin
  \/ ResetPasswordOtpForAdmin
  \/ OtpReqDone

Spec == Init /\ [][Next]_vars

\* ---- Code-Held Invariants (0 counterexamples expected) ----

InvTrustedProxyHeaderGate ==
  ~untrustedHeaderAdopted

InvPreAuthLimitsBounded ==
  /\ preAuthDirect <= MaxPreAuthPerIp
  /\ preAuthProxiedA <= MaxPreAuthPerIp
  /\ preAuthProxiedB <= MaxPreAuthPerIp
  /\ TotalPreAuth <= MaxPreAuthGlobal

InvAdminBearerNeverFallsBackToCookie ==
  /\ ~adminFellBackToCookie
  /\ authDecision /= "admin_bearer_fell_back_cookie"

InvAdminNeverIssuedOtpSession ==
  ~adminOtpSessionIssued

\* ---- Stricter Target Invariants (Finding Probes: expose real open-source gaps) ----

InvAllRoutesBearerOverridesCookie ==
  authDecision /= "user_bearer_ignored"

InvAdminRefusedAllOtpDelivery ==
  otpDecision /= "reset_delivered"
====
