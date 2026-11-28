export const title = "插件桥握手与路由转发状态机 (ZR-7)";

export const colors = {
  idle: "tan",
  adapter: "blue",
  plugin: "purple",
  bridged: "teal",
  refused: "orange",
};

export const state = (v) => {
  if (v.regOwner === "none") return "未注册";
  const owner = v.regOwner === "plugin" ? "插件自声明(v2)" : "适配器接管(v1)";
  if (v.bridgeState === "bridged") {
    return `${owner} / Bridged(全一致可转发)`;
  }
  if (v.lastReqKind === "virtual" && v.lastOutcome === "refused_503") {
    return `${owner} / 非 Bridged(虚拟路由拒回 503)`;
  }
  return `${owner} / 非 Bridged(离线或失配)`;
};

export const group = (v) => {
  if (v.regOwner === "none") return "idle";
  if (v.bridgeState === "bridged") return "bridged";
  if (v.lastReqKind === "virtual" && v.lastOutcome === "refused_503") return "refused";
  return v.regOwner === "plugin" ? "plugin" : "adapter";
};

export const step = (action, from, to) => {
  switch (action) {
    case "AdapterRegister":
      return "适配器注册 (v1, d1)";
    case "AdapterYieldsToPlugin":
      return null;
    case "PluginSelfRegister":
      return from.regOwner === "adapter"
        ? "插件自声明覆盖适配器 (v2, d2)"
        : "插件自声明注册 (v2, d2)";
    case "StaleAdapterDispose":
      return null;
    case "ActiveAdapterDispose":
      return "适配器注销";
    case "PluginDispose":
      return "插件自声明注销";
    case "HandshakeSync":
      if (to.bridgeState === "bridged") return "握手三元组+授权全一致";
      if (from.bridgeState === "bridged") return "握手失配或断线降级";
      return null;
    case "HandleVirtualRequest":
      return to.lastOutcome === "forwarded" ? null : "虚拟路由请求拒回 503 (不落本机)";
    case "HandleLocalRequest":
      return null;
    default:
      return action;
  }
};
