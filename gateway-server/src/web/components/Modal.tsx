// 居中模态框（PG-6b；PG-6b-fix 修复重渲染抢焦点）：半透明遮罩 + Esc / 点击
// 遮罩关闭。
//
// 焦点纪律（PG-6b-fix）：
//   - effect 只在挂载时安装一次（依赖 []）；onClose 经 ref 取最新值——父组件
//     每次渲染传进新的内联回调不再触发 effect 重装，输入框打字 / SSE 拓扑
//     推送重渲染都不会把焦点抢回容器，也不会覆盖子内容的 autoFocus；
//   - 只有挂载那一刻焦点还落在弹窗之外时才兜底聚焦容器（键盘用户立即
//     Esc 可用）；子内容带 autoFocus 输入框时不抢它的焦点；
//   - 卸载时把焦点归还给打开前的元素。
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 永远指向最新 onClose：effect 只装一次，父组件换引用也照常取到
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    // 子内容带 autoFocus 时 React 已在 commit 阶段聚焦它——contains 为真就不动
    if (dialog !== null && !dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
