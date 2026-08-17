import { BASE_CSS } from './base.css.ts'
import { LAYOUT_CSS } from './layout.css.ts'
import { COMPAT_CSS } from './compat.css.ts'
import { MISC_CSS } from './misc.css.ts'
import { HOME_CSS } from './home.css.ts'
import { HEADER_CSS } from './header.css.ts'

/**
 * All mobile styles, concatenated in the exact order of the original
 * single-file stylesheet (base → layout → compat → misc, where misc keeps
 * composer → tablet → desktop), followed by the phone app shell (home) and
 * the session-header reflow (header), which must come last so their <768px
 * rules win ties against the shared <=1023px block. Injected as ONE
 * <style data-plugin> tag — do not reorder.
 */
export const MOBILE_CSS = [BASE_CSS, LAYOUT_CSS, COMPAT_CSS, MISC_CSS, HOME_CSS, HEADER_CSS].join('\n')
