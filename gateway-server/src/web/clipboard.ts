// 跨上下文剪贴板写入（兼容 HTTPS / localhost 与非安全上下文 HTTP 部署）。
//
// 浏览器在非安全上下文（如 `http://<局域网或公网IP>:19393/`，`isSecureContext === false`）
// 下会将 `navigator.clipboard` 置为 `undefined`——直接调用 `.writeText()` 会同步抛
// `TypeError: Cannot read properties of undefined (reading 'writeText')`。
// 这里优先尝试标准异步 Clipboard API；缺失或拒绝时自动回落到离屏只读 `<textarea>` +
// `document.execCommand('copy')`，并还原焦点与选区，永不向外抛异常。
//
// 注意：本文件同时被后端 `tsconfig.json`（无 DOM lib，供 node:test 直接导入单测）
// 与前端 `tsconfig.web.json` 编译，因此使用最小结构接口描述宿主环境。

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
  body?: {
    appendChild(node: unknown): unknown;
    removeChild(node: unknown): unknown;
  } | null;
  activeElement?: { focus?: (options?: { preventScroll?: boolean }) => void } | null;
  createElement(tag: 'textarea'): CopyTextareaLike;
  execCommand?(command: 'copy'): boolean;
}

export interface CopyEnvironment {
  navigator?: {
    clipboard?: {
      writeText?: (text: string) => Promise<void>;
    };
  };
  document?: CopyDocumentLike;
}

export async function copyTextToClipboard(
  text: string,
  env: CopyEnvironment = globalThis as unknown as CopyEnvironment,
): Promise<boolean> {
  if (typeof text !== 'string') return false;

  const clipboard = env.navigator?.clipboard;
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
    doc.body === undefined ||
    doc.body === null ||
    typeof doc.createElement !== 'function' ||
    typeof doc.execCommand !== 'function'
  ) {
    return false;
  }

  const previousActive = doc.activeElement ?? null;
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  doc.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange?.(0, text.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    try {
      doc.body.removeChild(textarea);
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
