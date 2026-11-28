# GatewayRateLimitAuth

TLC reached 420 states and 2962 steps. The chart draws 14 states and 27 arrows.
The chart does not draw 300 steps that stay in one chart state.

## InvHttpProxyTrustConsistent breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. Admin Cookie 鉴权(带未信 XFP): WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 Admin Cookie 放行 (采信未信 X-Forwarded-Proto: Gap 3a), Admin_OTP_签发门控 OTP 请求待命

## InvAllRoutesBearerOverridesCookie breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. User 代理限流+Bearer+Cookie: WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 User 路由忽略 Bearer 且限流折叠至 socketIp (Finding 1 + Gap 3b), Admin_OTP_签发门控 OTP 请求待命

## InvAdminRefusedAllOtpDelivery breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. Admin 请求重置密码 OTP: WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 Admin 重置 OTP 仅发信无会话 (Finding 2)

## Rules that hold
TypeOK, InvTrustedProxyHeaderGate, InvPreAuthLimitsBounded, InvAdminBearerNeverFallsBackToCookie, InvAdminNeverIssuedOtpSession, NoDeadlock
