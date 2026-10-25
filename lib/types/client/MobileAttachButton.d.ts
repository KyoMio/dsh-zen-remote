import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from './locales.ts';
/** Full props for the composer attachment seat. */
export type MobileAttachButtonProps = PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS>;
/**
 * Composer attachment button (S7).
 *
 * Renders into `conversation.input.left`, which CSS orders to the leftmost
 * seat of the phone composer's bottom row (and hides at >= 768px, where the
 * official picker on the host machine is the right answer). Tapping it opens
 * the CLIENT's picker — no `accept` attribute on purpose, so iOS offers the
 * full 相册 / 拍照 / 选取文件 sheet rather than one of them.
 *
 * DSH 0.1.5 gave the official tool row its own paperclip, and this button
 * used to stand down whenever that flow's hidden `<input type="file">` was
 * probed in the composer (that probe file is deleted with #31), keeping one
 * attach control per composer. DSH 0.2.x then removed the standalone
 * paperclip (the file action moved into the `+` command menu) while KEEPING
 * the hidden input, so the probe matched on every host and the phone composer
 * was left with no attach affordance at all. The phone shell now always
 * renders this button — its picker is the CLIENT's (相册 / 拍照 / 选取文件),
 * and every attachment takes the same `@.dsh-uploads/` draft-token path on
 * every DSH version. On DSH ≤ 0.1.5, which still ships the second official
 * paperclip, composer.css.ts hides it below 768px so the row keeps exactly
 * one attach control. Subagent sessions stay buttonless, mirroring the host:
 * the official InputBar disables its own file input while
 * `subagent !== null`.
 *
 * Every picked file takes the SAME path: upload to the node half, then append
 * `@.dsh-uploads/name` to the draft through the official write path — no DOM
 * value poking: `inputActions.appendDraft` where the running DSH exposes it
 * (0.2.1-rc.3+ editor runtime; keeps the user's text and inline references),
 * else `inputActions.setDraft` with the whole next draft (attach-upload.ts
 * `writeMention`). S7.1 removed the split that used
 * to send inlineable images straight into the session with `session.prompt`:
 * one behaviour for every attachment, and the user always presses send.
 * MobileAttachChips renders the preview row off those same draft tokens.
 *
 * Files upload one at a time: a phone uplink gains nothing from parallelism
 * and a serial loop keeps the mentions in pick order.
 */
export declare function MobileAttachButton({ t, sessionId, useInput, inputActions, useSessions }: MobileAttachButtonProps): import("react").JSX.Element | null;
//# sourceMappingURL=MobileAttachButton.d.ts.map