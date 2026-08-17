import { BASE_CSS } from './base.css.ts'
import { LAYOUT_CSS } from './layout.css.ts'
import { COMPAT_CSS } from './compat.css.ts'
import { MISC_CSS } from './misc.css.ts'
import { HOME_CSS } from './home.css.ts'
import { HEADER_CSS } from './header.css.ts'
import { COMPOSER_CSS } from './composer.css.ts'
import { INFO_CSS } from './info.css.ts'
import { TURN_FOLD_CSS } from './turn-fold.css.ts'

/**
 * All mobile styles, concatenated in the exact order of the original
 * single-file stylesheet (base → layout → compat → misc, where misc keeps
 * composer → tablet → desktop), followed by the phone app shell (home), the
 * session-header reflow (header), the composer reflow (composer), and the
 * session-info sheet (info, which must come last of all: it re-shows a
 * header.utilities child header.css.ts hides by default, so its rule has to
 * win that tie too), and finally the turn-process fold (turn-fold, S8, which
 * shares no selector with any of them) — all appended in this order so their
 * <768px rules win ties against the shared <=1023px block. Injected as ONE
 * <style data-plugin> tag — do not reorder.
 */
export const MOBILE_CSS = [BASE_CSS, LAYOUT_CSS, COMPAT_CSS, MISC_CSS, HOME_CSS, HEADER_CSS, COMPOSER_CSS, INFO_CSS, TURN_FOLD_CSS].join('\n')
