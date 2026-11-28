# GatewayRateLimitAuth

TLC reached 480 states and 3388 steps. The chart draws 14 states and 26 arrows.
The chart does not draw 600 steps that stay in one chart state.

## InvHttpProxyTrustConsistent breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. Admin 有效 Bearer: WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 Admin Bearer API Key 放行, Admin_OTP_签发门控 OTP 请求待命

## InvAllRoutesBearerOverridesCookie breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. User 带 Bearer+Cookie: WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 User 路由忽略 Bearer 走 Cookie (Finding 1), Admin_OTP_签发门控 OTP 请求待命

## InvAdminRefusedAllOtpDelivery breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. Admin 请求重置密码 OTP: WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 Admin 重置 OTP 仅发信无会话 (Finding 2)

## Rules that hold
TypeOK, InvTrustedProxyHeaderGate, InvPreAuthLimitsBounded, InvAdminBearerNeverFallsBackToCookie, InvAdminNeverIssuedOtpSession, NoDeadlock
