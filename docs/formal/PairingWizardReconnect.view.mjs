export const title = "配对 + Wizard 重载 + Probe 断线重连状态机 (ZR-7 R1)";

export const colors = {
  wizard: "blue",
  reloading: "orange",
  online: "teal",
  degraded: "yellow",
  probing: "purple",
};

export const state = (v) => {
  if (!v.paired) {
    if (v.wizardPhase === "idle") return "未配对 / 向导空闲";
    if (v.wizardPhase === "reloading") return "未配对 / 整行重载中";
    if (v.codeMintedAtGen === -1) return "未配对 / 向导就绪(未铸码)";
    return "未配对 / 配对码已铸造";
  }
  if (v.wizardPhase === "reloading") return "已配对 / 整行重载中";
  if (v.hintInFlight) return "已配对 / Probe 探测在飞";
  if (v.relayState === "online") {
    return v.viewState === "online"
      ? "已配对 / 在线(视图 online)"
      : "已配对 / 在线(视图滞留 offline)";
  }
  if (v.relayState === "connecting") {
    return v.viewState === "online"
      ? "已配对 / 重连握手中(视图 online)"
      : "已配对 / 重连握手中(视图 offline)";
  }
  if (v.viewState === "online") return "已配对 / 离线(视图滞留 online)";
  return v.probeResult === "fail"
    ? "已配对 / 离线(Probe 失败禁止重连)"
    : "已配对 / 离线(视图 offline)";
};

export const group = (v) => {
  if (v.wizardPhase === "reloading") return "reloading";
  if (!v.paired) return "wizard";
  if (v.hintInFlight) return "probing";
  if (v.relayState === "online") return "online";
  return "degraded";
};

export const step = (action, from, to) => {
  switch (action) {
    case "WizardOpenWithoutRestart":
      return "打开向导(无重启字段变更)";
    case "WizardEditRestartField":
      return from.wizardPhase === "idle" || from.codeMintedAtGen !== -1 || from.relayState === "online"
        ? "修改重启字段触发 reload"
        : null;
    case "CompleteRowReload":
      return "整行重载完成";
    case "MintPairingCode":
      return "铸造配对码";
    case "ClaimPairing":
      return "提交配对码换取凭据";
    case "RejectUnauthWsUpgrade":
    case "WsUpgradeStart":
    case "WsUpstreamReady":
    case "HintSuppressedWhileOnline":
      return null;
    case "RevokeDevice":
      return from.relayState === "online" && !from.hintInFlight ? "吊销设备" : null;
    case "TransportDrop":
      return "长连接断开";
    case "StatusPollSync":
      return to.viewState === "online" ? "轮询同步视图为 online" : "轮询同步视图为 offline";
    case "SendNetworkHint":
      return "发送 network-hint 触发 probeHealth";
    case "CompleteProbe":
    case "ProbeSucceeds":
    case "ProbeFails":
      if (to.probeResult === "fail") {
        return to.relayState === "offline"
          ? "probe 失败(绝不自动重连)"
          : "probe 失败(维持当前态)";
      }
      return from.relayState === "offline" && to.relayState === "connecting"
        ? "probe 成功 -> networkRestored"
        : "probe 成功(非离线忽略)";
    case "ManualRetry":
      return "手动触发重连";
    case "ConnectSucceeds":
      return "重连成功";
    case "ConnectFails":
      return "重连失败";
    default:
      return action;
  }
};
