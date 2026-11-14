// 居中模态框（GC-7a 升级为原生 <dialog>）：showModal() 打开 + ::backdrop
// 半透明遮罩，Esc / 点击遮罩 / 右上角关闭按钮关闭。原生 dialog 自带焦点圈定
// 与无障碍语义，不再手写 role="dialog" / aria-modal / 焦点陷阱。
//
// 焦点纪律（PG-6b-fix，packaging.test.mjs 钉住）：
//   - effect 只在挂载时安装一次（依赖 []）；onClose 经 ref 取最新值——父组件
//     每次渲染传进新的内联回调不再触发 effect 重装，输入框打字 / SSE 拓扑
//     推送重渲染都不会把焦点抢回容器，也不会覆盖子内容的 autoFocus；
//   - 只有挂载那一刻焦点还落在弹窗之外时才兜底聚焦弹窗（键盘用户立即
//     Esc 可用）；子内容带 autoFocus 输入框时不抢它的焦点；
//   - 卸载时把焦点归还给打开前的元素。
//
// 关闭路径统一走 onClose 让 React 卸载弹窗（而不是浏览器自己 close 后组件
// 还挂着）：Esc 触发原生 cancel 事件（拦截默认关闭）；不支持 closedby 的
// 浏览器（如旧版 Safari）退回「点击遮罩（target 是 <dialog> 本身）关闭」。
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

import { LOCALE_STORAGE_KEY, resolveLocale, translate } from '../i18n/locales';
import { CloseIcon } from './Icons';

export interface ModalProps {
  title: string;
  /** 可选副标题：标题下的一句说明 */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

/** 关闭按钮的无障碍标签：与 App.tsx readStoredLocale 同源读一份持久化语言 */
function resolveCloseLabel(): string {
  try {
    const locale = resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY), navigator.language);
    return translate(locale, 'common.close');
  } catch {
    return 'Close';
  }
}

export function Modal({ title, subtitle, onClose, children }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pointerDownOnDialogRef = useRef(false);
  const titleId = useId();

  // 永远指向最新 onClose：effect 只装一次，父组件换引用也照常取到
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    // 子内容带 autoFocus 时 React 已在 commit 阶段聚焦它——contains 为真就不动
    if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    // Esc：拦截浏览器默认关闭，统一改走 onClose（由 React 卸载并归还焦点）
    const onCancel = (event: Event): void => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.returnValue = '';
      dialog.close();
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      className="modal"
      aria-labelledby={titleId}
      onPointerDown={(event) => {
        pointerDownOnDialogRef.current = event.target === dialogRef.current;
      }}
      onClick={(event) => {
        // 要求按下与松开都在 ::backdrop（<dialog> 本身）才关闭，
        // 避免用户在弹窗内拖选密码划到遮罩上松手时误关弹窗。
        const startedOnBackdrop = pointerDownOnDialogRef.current;
        pointerDownOnDialogRef.current = false;
        if (startedOnBackdrop && event.target === dialogRef.current) onCloseRef.current();
      }}
    >
      <header className="modal-header">
        <div className="modal-heading">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {subtitle !== undefined && <p className="modal-subtitle">{subtitle}</p>}
        </div>
        <button type="button" className="modal-close" aria-label={resolveCloseLabel()} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="modal-scroll">{children}</div>
    </dialog>
  );
}
