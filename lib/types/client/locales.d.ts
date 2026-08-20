/** `mobileNav` namespace dictionaries: drawer controls. */
export declare const NS = "mobileNav";
/** Simplified Chinese dictionary (the key-set source of truth). */
export declare const zh: {
    readonly open: "打开目录";
    readonly close: "收起目录";
    readonly backdrop: "点击关闭目录";
    readonly sessionLog: "导出会话日志";
    readonly files: "文件浏览";
    readonly previewFullscreen: "全屏预览";
    readonly previewExitFullscreen: "退出全屏";
    readonly allWorkspaces: "全部";
    readonly switchWorkspace: "切换工作区";
    readonly newSession: "新建会话";
    readonly noSessions: "还没有会话，点右下角加号开始";
    readonly homeStatusOngoing: "运行中";
    readonly homeStatusWarning: "待处理";
    readonly homeStatusDone: "已完成";
    readonly backToList: "返回会话列表";
    readonly sessionInfo: "会话信息";
    readonly workbench: "工作台";
    readonly workbenchClose: "关闭工作台";
    readonly switchView: "切换视图";
    readonly attach: "添加附件";
    readonly attachBusy: "上传中…";
    readonly attachFailed: "上传失败，点按重试";
    readonly attachRemove: "移除附件 {name}";
    readonly infoClose: "关闭";
    readonly infoMode: "模式";
    readonly infoCwdFallback: "未知目录";
    readonly infoSubagents: "{count} 个子代理";
    readonly infoJobs: "{count} 个后台任务";
    readonly activityOpen: "查看子代理与后台任务";
    readonly infoStatTurns: "轮次";
    readonly infoStatSteps: "步骤";
    readonly infoStatTtft: "首字延迟";
    readonly infoStatLlm: "模型耗时";
    readonly infoStatTool: "工具耗时";
    readonly infoStatCacheHit: "缓存命中";
    readonly infoTokenFlow: "Token {io}";
    readonly infoExport: "导出日志";
    readonly infoRename: "重命名";
    readonly infoRenamePrompt: "会话新名称";
    readonly infoFork: "Fork 会话";
    readonly infoArchive: "归档";
    readonly infoArchiveConfirm: "归档后将从会话列表隐藏，确定继续？";
    readonly infoActionError: "操作失败：{message}";
    readonly turnFold: "过程 · {count} 步";
    readonly turnFoldRunning: "进行中 · {count} 步";
    readonly settings: "设置";
    readonly chipTaskboard: "任务看板";
    readonly chipSsh: "SSH";
    readonly chipUsage: "用量";
    readonly chipCustomize: "自定义入口";
};
/** English dictionary, key-identical to the Chinese source of truth. */
export declare const en: Record<MobileNavKey, string>;
/** Key domain of the `mobileNav` namespace (zh is the source of truth). */
export type MobileNavKey = keyof typeof zh;
//# sourceMappingURL=locales.d.ts.map