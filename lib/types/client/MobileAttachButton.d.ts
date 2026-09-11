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
 * DSH 0.1.5 gave the official tool row its own paperclip (the host attachment
 * flow), which made TWO identical controls on a phone. This button now stands
 * down entirely while the host ships its own picker (`host-attach.ts` probes
 * for it) — the official flow uploads into `~/.dsh/attachments` and renders
 * its own rail, so the composer keeps exactly one attach affordance. On a
 * host without one (DSH ≤ 0.1.2) everything below loads exactly as before.
 *
 * Every picked file takes the SAME path: upload to the node half, then append
 * `@.dsh-uploads/name` to the draft through `inputActions.setDraft` (the
 * official write path — no DOM value poking). S7.1 removed the split that used
 * to send inlineable images straight into the session with `session.prompt`:
 * one behaviour for every attachment, and the user always presses send.
 * MobileAttachChips renders the preview row off those same draft tokens.
 *
 * Files upload one at a time: a phone uplink gains nothing from parallelism
 * and a serial loop keeps the mentions in pick order.
 */
export declare function MobileAttachButton({ t, sessionId, useInput, inputActions }: MobileAttachButtonProps): import("react").JSX.Element | null;
//# sourceMappingURL=MobileAttachButton.d.ts.map