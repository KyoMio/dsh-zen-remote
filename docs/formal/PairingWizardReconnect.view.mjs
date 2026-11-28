export const title = "配对 + Wizard 重载 + Probe 断线重连状态机 (ZR-7)";

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
  if (v.relayState === "online") {
    return v.wsAdmitted ? "已配对 / 在线(WS 已建连)" : "已配对 / 在线(待 WS)";
  }
  if (v.relayState === "probing") return "已配对 / Probe 探测中";
  if (v.relayState === "connecting") return "已配对 / 重连握手中";
  if (v.viewState === "online") return "已配对 / 离线(视图滞留 online)";
  return v.probeOutcome === "fail"
    ? "已配对 / 离线(Probe 失败禁止重连)"
    : "已配对 / 离线(等待恢复)";
};

export const group = (v) => {
  if (!v.paired) {
    return v.wizardPhase === "reloading" ? "reloading" : "wizard";
  }
  if (v.relayState === "online") return "online";
  if (v.relayState === "probing") return "probing";
  return "degraded";
};

export const step = (action, from, to) => {
  switch (action) {
    case "WizardOpenWithoutRestart":
      return "打开向导(无重启字段变更)";
    case "WizardEditRestartField":
      return "修改重启字段触发 reload";
    case "CompleteRowReload":
      return "整行重载完成";
    case "MintPairingCode":
      return "铸造配对码";
    case "ClaimPairing":
      return "提交配对码换取凭据";
    case "RejectUnauthWsUpgrade":
      return null;
    case "AdmitAuthWsUpgrade":
      return "已认证 WS upgrade 建连";
    case "RevokeDevice":
      return from.relayState === "online" ? "吊销设备" : null;
    case "TransportDrop":
      return "长连接断开";
    case "StatusPollSync":
      return "状态轮询同步为 offline";
    case "HintSuppressedWhileOnline":
      return null;
    case "NetworkHintSend":
      return "发送 network-hint 触发 probe";
    case "ProbeSucceedsAndRestores":
      return "probe 成功 -> networkRestored";
    case "ProbeFailsNoReconnect":
      return "probe 失败(不重连)";
    case "ManualRetry":
      return "用户手动重连";
    case "ConnectSucceeds":
      return "重连成功";
    case "ConnectFails":
      return "重连失败";
    default:
      return action;
  }
};
