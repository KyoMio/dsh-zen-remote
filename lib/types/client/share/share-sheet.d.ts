import type { ReactNode } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from '../locales.ts';
/** Which range the user picked: everything, or the last N turns. */
export type SharePreset = 'all' | number;
/** Props: locale seat + the two callbacks the info sheet wires to its layer stack. */
export type ShareRangeSheetProps = PropsLocale<typeof NS> & {
    /** True while fetch → render → rasterize runs: options and confirm lock, confirm copy flips to 生成中. */
    busy: boolean;
    /** Confirmed a range — the caller starts the pipeline. */
    onConfirm: (preset: SharePreset) => void;
    /** Close request (mask tap, ✕, or the back-driven close). */
    onClose: () => void;
};
/** The share-range sheet. Rendered only while open (the caller owns the layer stack). */
export declare function ShareRangeSheet({ busy, onConfirm, onClose, t }: ShareRangeSheetProps): ReactNode;
//# sourceMappingURL=share-sheet.d.ts.map