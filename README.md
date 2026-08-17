<h1 align="center">dsh-mobile-remote</h1>
<p align="center">让 DeepSeek Harness 变成一个可以从公网安全访问的手机 App——移动端 UI 全面重排 + 配对认证网关 + PWA + 推送 + 附件上传。</p>

[![Release v1.0.0](https://img.shields.io/badge/release-v1.0.0-5B4CF0?style=flat-square)](#版本线)
[![License: MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web%20Profile-5B4CF0?style=flat-square)](#安装)
[![packages: 2](https://img.shields.io/badge/packages-mobile--ui%20%2B%20gateway-4c8dff?style=flat-square)](#两个包的分工)

DSH 官方的 Web UI 是给电脑屏幕做的，而且只监听 `127.0.0.1`——手机上打不开，出门也够不着。这个仓库把两件事一起解决：**界面按手机重排**，**通道按公网加固**。装完之后，你在手机上加到主屏的那个图标，点开就是一个全屏运行、有推送、能传照片、认令牌不认 IP 的 DSH 客户端。

---

## 效果

| 会话列表主屏 | 会话页 | 会话信息卡 |
| --- | --- | --- |
| ![会话列表主屏](assets/home.png) | ![会话页](assets/session.png) | ![会话信息卡](assets/info.png) |

| composer 权限 sheet | 公网设备看到的配对页 |
| --- | --- |
| ![composer 权限 sheet](assets/sheet.png) | ![配对页](assets/pairing.png) |

> 截图取自当前构建（390×844 手机视口、伪造刘海安全区、深色主题——DSH 默认主题；界面白色鲸鱼 logo 是深色适配的一部分）。前四张是 `packages/mobile-ui` 的界面，最后一张是 `packages/gateway` 挡在公网前面的配对墙。

---

## 两个包的分工

一句话：**mobile-ui 管「长什么样、怎么操作」，gateway 管「谁能进来、怎么进来」。** 两个包互相独立、可以单装，合起来才是完整的手机端方案。

| | `packages/mobile-ui` | `packages/gateway` |
| --- | --- | --- |
| 包名（profile 里写的名字） | `@dsh-external/dsh-mobile-nav` | `dsh-mobile-pwa` |
| 版本线 | v2.0.0 | v0.3.0 |
| 管什么 | 手机端信息架构与排版：两级页面栈、会话列表主屏、composer 重排、底部 sheet、手势、回合折叠、附件上传端点 | 通道与外壳：配对码认证、设备令牌、限流、PWA 安装清单、service worker、首帧安全区注入、Web Push |
| 跑在哪 | 浏览器里的客户端插件（外加一条 host 上传路由） | DSH 主进程旁的独立 Node 子进程（默认 `127.0.0.1:3088`） |
| 单装会怎样 | 手机界面变好用，但仍然只能在本机/局域网直连 | 能从公网安全访问、能装到主屏、能收推送，但界面还是桌面布局压窄 |

```
公网手机 --HTTPS--> 你自己的反代(nginx/Caddy/Lucky，终结 TLS)
                          │  HTTP + X-Forwarded-For/Proto
                          ▼
          gateway 网关子进程(默认只听 127.0.0.1:3088)
            · 没令牌 → 配对页       · 有令牌 → 反代到 DSH
            · 本机直连 → 管理页/推送触发（经反代进来一律 403）
                          │  注入 manifest / SW / viewport-fit
                          ▼
              DSH Web UI (127.0.0.1:3080)
                          │  客户端加载 mobile-ui 插件
                          ▼
                手机上的两级页面栈 App 界面
```

两边的 CSS 不重叠：排版类规则一律在 mobile-ui，gateway 只留壳级规则（iOS 输入框防缩放、安全区滚动补偿、代码块横向滚动）。这条边界是踩过坑之后划清的——网关里曾经残留一份没人记得的 CSS 副本，把 mobile-ui 的信息卡撑满了整个屏幕。

---

## 功能亮点

### 界面（mobile-ui）

- **两级页面栈**：启动落在会话列表主屏，点进去是独立会话页，横向推入/推出，不再是「桌面抽屉的窄屏版」；
- **主屏插件入口 chips**：文件浏览、用量、定时任务等按你实际装的插件动态出现——**任何在官方侧栏注册了快捷入口的插件都会被自动发现**，装上就长出 chip，不用等适配更新；显隐可自定义、本地持久化；
- **composer 重排**：底排控件全部图标化，权限/模型菜单变成从底部升起的 sheet，顶部用渐变 mask 代替硬分割线；
- **会话信息卡**：轮数/步数/首字延迟/模型耗时/工具耗时/token 六格统计，加导出日志、重命名、Fork、归档四个操作，收进按需打开的底部卡片；
- **回合过程折叠**：同一回合里的推理块、工具调用默认收成一条「过程 · N 步」摘要行，最终回复永远直接可见；
- **手势**：左边缘右滑返回列表，各类底部 sheet 下滑关闭；
- **手机本地附件上传**：回形针打开的是手机自己的相册/文件选择器（官方那套是在跑 DSH 的电脑上弹窗，远程用不了），文件落到会话工作目录的 `.dsh-uploads/`，composer 上方出现可删的预览 chip，并把 `@.dsh-uploads/文件名` 追加进输入框——**什么时候发由你按发送键决定**，不替你自动发出。

### 通道（gateway）

- **配对码换设备令牌**：新设备在本机管理页拿一次性配对码，换一个长期设备令牌（HttpOnly Cookie），此后身份跟着令牌走，与来源 IP 无关——家里 Wi-Fi、手机流量、换网络都不用重新审批；
- **管理面本机独占**：生成配对码、管理设备、触发推送这些接口只认本机直连，凡是带转发头（也就是经过反代）的请求一律 403；
- **真 PWA**：manifest + service worker，反代带来 HTTPS 后「添加到主屏」真正生效，全屏独立窗口、有图标启动屏；SW 只把静态壳做缓存优先，DSH 的 JS/CSS/API/页面一律网络优先，不会出现「新 DOM 配旧 CSS」；
- **真 Web Push**：VAPID 签名 + aes128gcm 加密，agent 干完活推到锁屏，通知默认不带对话正文；
- **`push_notify` 工具**：模型可以自己决定在关键节点推一条给你（要人拿主意、出错需要处理），带同会话 60 秒 1 条、全局每小时 20 条的兜底限流，配置里可整体关掉。

---

## 安装

两个包都是 DSH profile 的 bundle 插件，用本地路径 link 装。编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    // 路径换成你 clone 这个仓库的位置
    "@dsh-external/dsh-mobile-nav": "link:/path/to/dsh-mobile-remote/packages/mobile-ui",
    "dsh-mobile-pwa": "link:/path/to/dsh-mobile-remote/packages/gateway"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-mobile-pwa",
        "@dsh-external/dsh-mobile-nav"
      ]
    }
  }
}
```

注意 `dsh.profile.bundles` 里写的是**包名**（`@dsh-external/dsh-mobile-nav`、`dsh-mobile-pwa`），不是目录名——合并进这个仓库之后包名一个都没改，从老仓库切过来只需要改 `link:` 路径。

然后：

```sh
cd ~/.dsh/profiles/web && pnpm install
# 重启 dsh web
```

只想装其中一个？把另一行从 `dependencies` 和 `bundles` 里删掉即可，两个包没有互相依赖。

网关要对公网开放，还需要你自己配一个终结 TLS 的反代（nginx / Caddy / Lucky 的配置样例、环境变量表、配对流程、安全边界，见 [`packages/gateway/README.md`](packages/gateway/README.md)）。界面侧的断点策略、调试徽章、兼容插件清单见 [`packages/mobile-ui/README.md`](packages/mobile-ui/README.md)。

### 从源码构建

```sh
cd packages/mobile-ui && pnpm install && pnpm build   # 产物 lib/ 与源码一起入库
cd packages/gateway   && npm install  && npm test     # 43 个测试：反代注入 / 配对 / 推送 / SW
```

---

## 已知问题

### iOS 26.x 独立 PWA 视口缩水

iPhone 上加到主屏、以独立 PWA 打开后，视口底部会凭空少掉一截（实测 iOS 26.5 上 852 的屏幕高度对 793 的视口高度，正好一条状态栏），冷启动就在，直到彻底退出重开；同一网址在普通 Safari 标签页里完全正常。

**这是 iOS 26.x 的系统缺陷，不是本仓库的 bug**——独立 PWA 第一次弹出软键盘后布局视口永久变矮，`innerHeight` / `visualViewport.height` / `100dvh` 三个值一起变小，社区已有记录。少掉的那截在文档范围之外，任何 CSS 都够不着。我们做了三层缓解，**都不是根治**：

1. gateway 把 manifest 的 `background_color` 改成浅色，让系统画的那条死区看起来像页面背景的延伸，而不是一条突兀的黑条（代价：启动闪屏也跟着变浅，深色主题下这条带反而更显眼）；
2. mobile-ui 检测到缩水后，把差值补进自己的安全区变量 `--mnav-sab`，让 composer 不被吃掉；
3. mobile-ui 在失焦、冷启动 1 秒/3 秒、切回前台时各触发一次强制重排，逼 WebKit 重新测量视口——能不能治好看机型和系统版本，失败几次后自动停手。

### 经反代访问时，设置页的插件配置卡片列表加载不出来

现象：直连 `127.0.0.1:3080` 正常，经反代访问时设置页里的插件配置区域永久空白。

**根因在 DSH 官方客户端，不在网关**（真实反代链路完整复现，网关的头改写、WebSocket 代理、SSE 透传逐项排除）：官方客户端的连接就绪判定要求 `host.describe` 加两条 WebSocket 在 3 秒内全部建立，而真实反代的 TLS + 转发延迟叠加首屏请求洪峰很容易超时，触发重连；插件配置卡片列表只在启动时注册一次，重连后不恢复，于是永远空白（涉及 `@deepseek-ai/dsh-client-connection` 与 `dsh-client-ui-settings-plugins`）。

**绕法**：需要改插件配置时，回到本机浏览器用 `127.0.0.1:3080` 或 `127.0.0.1:3088` 改。配置存在后端，改完从手机侧访问其它功能完全不受影响。

---

## 上游致谢

这个仓库不是从零写的，两个包各自衍生自一个社区项目，**均为 MIT，本仓库延续 MIT 许可**，原始版权行保留在 [`LICENSE`](LICENSE) 里。

| 本仓库的包 | 上游 | 本仓库做了什么 |
| --- | --- | --- |
| `packages/mobile-ui` | [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) | 上游 v1.0.0 做的是「把桌面布局压成窄屏」——保留桌面的抽屉/侧栏，用 CSS 塞进手机宽度，并打下了分主题 CSS 结构、构建脚本、平板兼容段的底子。**v2.0 是一次 app 化重写**：手机断点改成两级页面栈的 app 信息架构，加上 composer 重排、信息卡、手势、回合折叠、附件上传、插件入口 chips。平板保持上游行为不倒退，桌面严格逐像素不变。 |
| `packages/gateway` | [zylzyqzz/dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa)（其自身衍生自 MIT 的 [Bernardxu123/dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate)） | 上游是局域网内按来源 IP 审批的网关加一层 PWA 外壳。**v0.2–v0.3 是壳与通道的大修**：认证换成配对码 + 每设备长期令牌（废除按 IP 审批与回环直通，这是对公网开放的前提），推送从「假推送」改成 VAPID 签名 + aes128gcm 加密的真 Web Push，service worker 重写缓存策略，修好 manifest 被上游标签遮挡、SW 作用域、首帧安全区等一串安装问题，并把排版类 CSS 整体让给 mobile-ui。 |

感谢上游作者的原始工作——没有那两份底子，这个仓库不会存在。

---

## 版本线

- 仓库自己走一条合并版本线，从 **v1.0.0** 起（= 两个包首次合仓）；
- **两个子包沿用各自原有的版本号**（mobile-ui v2.0.0、gateway v0.3.0），各自 `package.json` 里的版本不因合仓而重置；
- 两边的**完整提交历史都在**：合并用的是 `git subtree add`，不是把文件复制过来。`git log` 能看到两个上游仓库的全部提交（含各自的 tag 时点）；由于 subtree 合入不改写历史提交里的路径，想看某个文件合仓之前的历史，用它当时的路径查，例如 `git log <合入前的提交> -- README.md`。

## License

[MIT](LICENSE)。两份上游版权行都保留在 LICENSE 文件里。
