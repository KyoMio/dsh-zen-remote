// 跨上下文剪贴板写入（兼容 HTTPS / localhost 与非安全上下文 HTTP 部署，以及 <dialog>.showModal() 模态层）。
//
// 1. 浏览器在非安全上下文（如 `http://<局域网或公网IP>:19393/`，`isSecureContext === false`）
//    下会将 `navigator.clipboard` 置为 `undefined`——直接调用 `.writeText()` 会同步抛错，
//    因此必须回落到 `<textarea>` + `document.execCommand('copy')`。
// 2. HTML 规范下 `dialog.showModal()` 会把 `<dialog>` 之外的所有节点（包括 `document.body`）
//    置为模态阻塞状态（inert）；若回落 `<textarea>` 仍挂到 `document.body` 上，浏览器的
//    `focus()` / `select()` / `execCommand('copy')` 会静默失效。这里优先把 `<textarea>`
//    挂载到当前打开的顶层 `dialog[open]` 内（否则才退回 `document.body`），且跳过 `await`
//    以保持点击手势（transient user activation）同步生效。
//
// 注意：本文件同时被后端 `tsconfig.json`（无 DOM lib，供 node:test 直接导入单测）
// 与前端 `tsconfig.web.json` 编译，因此使用最小结构接口描述宿主环境。

export interface CopyContainerLike {
  appendChild(node: unknown): unknown;
  removeChild(node: unknown): unknown;
}

export interface CopyTextareaLike {
  value: string;
  readOnly: boolean;
  style: {
    position: string;
    top: string;
    left: string;
    opacity: string;
    pointerEvents: string;
  };
  setAttribute(name: string, value: string): void;
  focus(options?: { preventScroll?: boolean }): void;
  select(): void;
  setSelectionRange?(start: number, end: number): void;
}

export interface CopyDocumentLike {
  body?: CopyContainerLike | null;
  activeElement?: {
    focus?: (options?: { preventScroll?: boolean }) => void;
    closest?: (selector: string) => CopyContainerLike | null;
  } | null;
  querySelectorAll?: (selector: string) => ArrayLike<CopyContainerLike>;
  createElement(tag: 'textarea'): CopyTextareaLike;
  execCommand?(command: 'copy'): boolean;
}

export interface CopyEnvironment {
  isSecureContext?: boolean;
  navigator?: {
    clipboard?: {
      writeText?: (text: string) => Promise<void>;
    };
  };
  document?: CopyDocumentLike;
}

function resolveCopyContainer(doc: CopyDocumentLike): CopyContainerLike | null {
  try {
    const fromActive = doc.activeElement?.closest?.('dialog[open]') ?? null;
    if (fromActive !== null) return fromActive;
  } catch {
    // 忽略测试桩或异常 activeElement
  }
  try {
    if (typeof doc.querySelectorAll === 'function') {
      const openDialogs = doc.querySelectorAll('dialog[open]');
      if (openDialogs.length > 0) {
        return openDialogs[openDialogs.length - 1] ?? null;
      }
    }
  } catch {
    // 忽略不支持选择器查询的测试桩
  }
  return doc.body ?? null;
}

export async function copyTextToClipboard(
  text: string,
  env: CopyEnvironment = globalThis as unknown as CopyEnvironment,
): Promise<boolean> {
  if (typeof text !== 'string') return false;

  const clipboard = env.isSecureContext === false ? undefined : env.navigator?.clipboard;
  if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText.call(clipboard, text);
      return true;
    } catch {
      // 标准 API 被权限策略或非安全上下文拒绝时，继续尝试 execCommand 回退。
    }
  }

  const doc = env.document;
  if (
    doc === undefined ||
    doc === null ||
    typeof doc.createElement !== 'function' ||
    typeof doc.execCommand !== 'function'
  ) {
    return false;
  }

  const container = resolveCopyContainer(doc);
  if (container === null) return false;

  const previousActive = doc.activeElement ?? null;
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  container.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange?.(0, text.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    try {
      container.removeChild(textarea);
    } catch {
      // ignore detached node
    }
    try {
      previousActive?.focus?.({ preventScroll: true });
    } catch {
      // ignore focus restoration refusal
    }
  }
}
