export const title = "开源 gateway-server 限流与鉴权会话状态机 (ZR-7 R2)";

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
  return v.wsReqFromTrusted
    ? "WS 信任代理占用 (采纳 X-Real-IP)"
    : "WS 直连占用 (忽略伪造头)";
};

const authLabel = (v) => {
  if (v.reqRouteKind === "none") return "HTTP 鉴权待命";
  if (v.reqRouteKind === "admin") {
    if (v.authActor === "api_admin") return "Admin Bearer API Key 放行";
    if (v.authActor === "cookie_admin") {
      return v.httpIsHttps && !v.httpFromTrusted
        ? "Admin Cookie 放行 (采信未信 X-Forwarded-Proto: Gap 3a)"
        : "Admin Cookie 放行";
    }
    return "Admin 无效 Bearer 拒 401";
  }
  return v.reqBearerKind === "none"
    ? "User Cookie 放行"
    : "User 路由忽略 Bearer 且限流折叠至 socketIp (Finding 1 + Gap 3b)";
};

const otpLabel = (v) => {
  if (v.otpPurpose === "none") return "OTP 请求待命";
  if (v.otpTargetRole === "admin") {
    return v.otpPurpose === "signup"
      ? "Admin 注册 OTP 被拒"
      : "Admin 重置 OTP 仅发信无会话 (Finding 2)";
  }
  return "User 注册 OTP 签发会话";
};

export const state = (v) => ({
  WS_限流与代理头门控: wsLabel(v),
  HTTP_Bearer与Cookie鉴权: authLabel(v),
  Admin_OTP_签发门控: otpLabel(v),
});

export const group = (v) => {
  if (v.wsDecision === "rejected_1013") return "limit";
  if (v.reqRouteKind !== "none" || v.otpPurpose !== "none") return "auth";
  if (v.wsDecision !== "idle") return "ws";
  return "idle";
};

export const step = (action, from, to) => {
  switch (action) {
    case "WsConnect":
      if (to.wsDecision === "rejected_1013") {
        return to.wsReqFromTrusted ? "信任代理超限 -> 1013" : "未信对端超限 -> 1013";
      }
      return to.wsReqFromTrusted ? "信任代理建连(采纳 X-Real-IP)" : "未信对端建连(忽略伪造头)";
    case "WsReleasePreAuth":
      return "释放 WS 槽位";
    case "HttpAuthCase":
    case "HttpAuthRequest":
      if (to.reqRouteKind === "admin" && to.authActor === "api_admin") return "Admin 有效 Bearer";
      if (to.reqRouteKind === "admin" && to.authActor === "rejected_401") return "Admin 无效 Bearer 拒 401";
      if (to.reqRouteKind === "admin") return "Admin Cookie 鉴权(带未信 XFP)";
      if (to.reqRouteKind === "user" && to.reqBearerKind !== "none") return "User 代理限流+Bearer+Cookie";
      return "User Cookie 鉴权";
    case "HttpAuthDone":
      return "HTTP 请求完成";
    case "OtpCase":
    case "OtpRequest":
      if (to.otpTargetRole === "admin" && to.otpPurpose === "signup") return "Admin 请求注册 OTP";
      if (to.otpTargetRole === "admin") return "Admin 请求重置密码 OTP";
      return "User 注册 OTP";
    case "OtpReqDone":
      return "OTP 请求完成";
    default:
      return action;
  }
};
