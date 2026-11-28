export const title = "插件桥握手与路由转发状态机 (ZR-7 R1)";

export const colors = {
  idle: "tan",
  adapter: "blue",
  plugin: "purple",
  bridged: "teal",
  refused: "orange",
};

export const state = (v) => {
  if (v.regOwner === "none") return "未注册(透传宿主原路由)";
  const owner = v.regOwner === "plugin" ? "插件自声明(v2)" : "适配器接管(v1)";
  if (v.bridgeState === "bridged") {
    return v.lastOutcome === "refused_503"
      ? `${owner} / Bridged(服务端复核拒 503)`
      : `${owner} / Bridged(全一致可转发)`;
  }
  if (v.lastReqKind === "virtual" && v.lastOutcome === "refused_503") {
    return `${owner} / 非 Bridged(虚拟路由拒回 503)`;
  }
  return `${owner} / 非 Bridged(离线或失配)`;
};

export const group = (v) => {
  if (v.regOwner === "none") return "idle";
  if (v.lastReqKind === "virtual" && v.lastOutcome === "refused_503") return "refused";
  if (v.bridgeState === "bridged") return "bridged";
  return v.regOwner === "plugin" ? "plugin" : "adapter";
};

export const step = (action, from, to) => {
  switch (action) {
    case "AdapterRegister":
      return "适配器注册 (v1, d1)";
    case "AdapterYieldsToPlugin":
    case "StaleAdapterDispose":
    case "HandleLocalRequest":
    case "HandleUnregisteredRoute":
      return null;
    case "PluginSelfRegister":
      return from.regOwner === "adapter"
        ? "插件自声明覆盖适配器 (v2, d2)"
        : "插件自声明注册 (v2, d2)";
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
    case "ServerRefusesBridgedCall":
      return "服务端复核拒回 503 (不落本机)";
    default:
      return action;
  }
};
