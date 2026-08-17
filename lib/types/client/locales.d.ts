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
    readonly newSessionIn: "在工作区新建会话";
    readonly noSessions: "还没有会话，点右下角加号开始";
    readonly backToList: "返回会话列表";
    readonly sessionInfo: "会话信息";
    readonly workbench: "工作台";
    readonly switchView: "切换视图";
};
/** English dictionary, key-identical to the Chinese source of truth. */
export declare const en: Record<MobileNavKey, string>;
/** Key domain of the `mobileNav` namespace (zh is the source of truth). */
export type MobileNavKey = keyof typeof zh;
//# sourceMappingURL=locales.d.ts.map