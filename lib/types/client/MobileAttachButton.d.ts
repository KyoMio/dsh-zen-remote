import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionFace, SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client';
import { NS } from './locales.ts';
/** Full props for the composer attachment seat. */
export type MobileAttachButtonProps = PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS> & {
    /** Bound ctx.sessions.binding(id)?.session.prompt(parts, 'queue'); undefined when the binding is gone. */
    promptImages: (sessionId: SessionId, content: PromptContentPart[]) => ReturnType<SessionFace['prompt']> | undefined;
};
/**
 * Composer attachment button (S7).
 *
 * Renders into `conversation.input.left`, which CSS orders to the leftmost
 * seat of the phone composer's bottom row (and hides at >= 768px, where the
 * official picker on the host machine is the right answer). Tapping it opens
 * the CLIENT's picker — no `accept` attribute on purpose, so iOS offers the
 * full 相册 / 拍照 / 选取文件 sheet rather than one of them.
 *
 * Picked files split down two paths, because DSH publishes no upload API and
 * only one public browser->host byte channel:
 *
 * - an inlineable image (png/jpeg/webp/gif) becomes a `PromptContentPart` and
 *   goes through `session.prompt(parts, 'queue')` — which SENDS the batch as
 *   a turn, carrying the current draft as its text so a typed caption is not
 *   stranded behind the photo;
 * - anything else (HEIC, PDF, zip, …) is POSTed to the node half's route,
 *   lands in the session workspace, and its `@path` is appended to the draft
 *   for the user to send when they are ready.
 *
 * Files upload one at a time: a phone uplink gains nothing from parallelism
 * and a serial loop keeps the `@path` mentions in pick order.
 */
export declare function MobileAttachButton({ t, sessionId, useInput, inputActions, promptImages }: MobileAttachButtonProps): import("react").JSX.Element;
//# sourceMappingURL=MobileAttachButton.d.ts.map