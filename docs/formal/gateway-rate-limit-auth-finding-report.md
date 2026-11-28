# GatewayRateLimitAuth

TLC reached 270 states and 1977 steps. The chart draws 13 states and 25 arrows.
The chart does not draw 270 steps that stay in one chart state.

## InvAdminRefusedAllOtpDelivery breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. Admin 请求重置密码 OTP: WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 Admin 重置 OTP 仅发信(无会话)

## InvAllRoutesBearerOverridesCookie breaks
The shortest path has 1 step:
0. WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 HTTP 鉴权待命, Admin_OTP_签发门控 OTP 请求待命
1. User 路由带 Bearer+Cookie: WS_限流与代理头门控 WS 空闲 (0 占用), HTTP_Bearer与Cookie鉴权 User 路由忽略 Bearer 走 Cookie, Admin_OTP_签发门控 OTP 请求待命

## Rules that hold
TypeOK, InvTrustedProxyHeaderGate, InvPreAuthLimitsBounded, InvAdminBearerNeverFallsBackToCookie, InvAdminNeverIssuedOtpSession, NoDeadlock
