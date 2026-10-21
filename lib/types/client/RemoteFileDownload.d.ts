import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from './locales.ts';
import type { SaveRemoteFile } from './remote-file-save.ts';
/**
 * Structural mirrors of the two host slot contracts. This package does not
 * depend on dsh-client-ui-deliverables / dsh-client-ui-sidebar-documentpreview
 * (the owners' type-only merges would normally provide these), so the mirror
 * records ONLY what this action reads: both slots are session-scoped lists;
 * the card carries the open-route coordinates, the document header carries
 * the resolved absolute path.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'deliverables.file.actions': {
            kind: 'list';
            scope: 'session';
            owner: {
                actionUrl: string;
                available: boolean;
                pending: boolean;
                onAction: (action: string, application?: string) => unknown;
            };
        };
        'sidebar.right.tab.document.actions': {
            kind: 'list';
            scope: 'session';
            owner: {
                absolutePath: string;
            };
        };
    }
}
/** Props the delivered-file card entry receives. */
export interface DeliverableDownloadProps extends PropsRuntime<'deliverables.file.actions'>, PropsLocale<typeof NS> {
    /** Bound by this plugin's registration: the relayed read+save capability. */
    saveFile: SaveRemoteFile;
}
/**
 * The deliverable card entry. Renders nothing on a local session.
 * @param props - the card slot's owner props plus the injected save
 * capability and copy.
 * @returns the save button, or null.
 */
export declare function DeliverableDownload({ sessionId, t, saveFile }: DeliverableDownloadProps): import("react").JSX.Element | null;
/** Props the document-preview header entry receives. */
export interface DocumentDownloadProps extends PropsRuntime<'sidebar.right.tab.document.actions'>, PropsLocale<typeof NS> {
    /** Bound by this plugin's registration: the relayed read+save capability. */
    saveFile: SaveRemoteFile;
}
/**
 * The document preview header entry. Renders nothing on a local session.
 * @param props - the document slot's owner props plus the injected save
 * capability and copy.
 * @returns the save button, or null.
 */
export declare function DocumentDownload({ sessionId, t, saveFile, absolutePath }: DocumentDownloadProps): import("react").JSX.Element | null;
//# sourceMappingURL=RemoteFileDownload.d.ts.map