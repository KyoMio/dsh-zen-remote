export const title = "开源 gateway-server 限流与鉴权会话状态机 (ZR-7)";

export const colors = {
  idle: "tan",
  ws: "blue",
  limit: "orange",
  auth: "teal",
  finding: "purple",
};

const wsLabel = (v) => {
  const total = v.preAuthDirect + v.preAuthProxiedA + v.preAuthProxiedB;
  if (v.wsDecision === "rejected_1013") return "WS 超限拒连 1013";
  if (total === 0) return "WS 空闲 (0 占用)";
  if (total >= 2) return "WS 全局槽位已满";
  return v.wsDecision === "proxy_ok"
    ? "WS 信任代理占用 (采纳 X-Real-IP)"
    : "WS 直连占用 (忽略伪造头)";
};

const authLabel = (v) => {
  switch (v.authDecision) {
    case "admin_bearer_ok":
      return "Admin Bearer 放行";
    case "admin_bearer_401":
      return "Admin 无效 Bearer 拒 401";
    case "admin_cookie_ok":
      return "Admin Cookie 放行";
    case "user_bearer_ignored":
      return "User 路由忽略 Bearer 走 Cookie";
    default:
      return "HTTP 鉴权待命";
  }
};

const otpLabel = (v) => {
  switch (v.otpDecision) {
    case "signup_denied":
      return "Admin 注册 OTP 被拒";
    case "reset_delivered":
      return "Admin 重置 OTP 仅发信(无会话)";
    default:
      return "OTP 请求待命";
  }
};

export const state = (v) => ({
  WS_限流与代理头门控: wsLabel(v),
  HTTP_Bearer与Cookie鉴权: authLabel(v),
  Admin_OTP_签发门控: otpLabel(v),
});

export const group = (v) => {
  if (v.wsDecision === "rejected_1013") return "limit";
  if (v.authDecision === "user_bearer_ignored" || v.otpDecision === "reset_delivered") return "finding";
  if (v.authDecision !== "idle" || v.otpDecision !== "idle") return "auth";
  if (v.wsDecision !== "idle") return "ws";
  return "idle";
};

export const step = (action, from, to) => {
  switch (action) {
    case "WsConnectUntrusted":
      return to.wsDecision === "rejected_1013" ? "未信对端超限 -> 1013" : "未信对端建连(忽略伪造头)";
    case "WsConnectTrustedProxyA":
    case "WsConnectTrustedProxyB":
      return to.wsDecision === "rejected_1013" ? "信任代理超限 -> 1013" : "信任代理建连(采纳 X-Real-IP)";
    case "WsReleasePreAuth":
      return "释放 WS 槽位";
    case "AdminReqValidBearerWithCookie":
      return "Admin 有效 Bearer+Cookie";
    case "AdminReqInvalidBearerWithCookie":
      return "Admin 无效 Bearer+Cookie -> 401";
    case "AdminReqCookieOnly":
      return "Admin 仅带 Cookie";
    case "UserReqWithBearerAndCookie":
      return "User 路由带 Bearer+Cookie";
    case "HttpAuthDone":
      return "HTTP 请求完成";
    case "SignupOtpForAdmin":
      return "Admin 请求注册 OTP";
    case "ResetPasswordOtpForAdmin":
      return "Admin 请求重置密码 OTP";
    case "OtpReqDone":
      return "OTP 请求完成";
    default:
      return action;
  }
};
