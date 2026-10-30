import { record } from '@rrweb/record'
import type { ReplayModule } from './kma'

/** Records the page with rrweb. Every input is masked; mark anything else private
 * with the data-kma-mask (text hidden) or data-kma-block (element hidden) attribute. */
export const replay: ReplayModule = {
  start(emit) {
    const stop = record({
      emit,
      maskAllInputs: true,
      maskTextSelector: '[data-kma-mask]',
      blockSelector: '[data-kma-block]',
      ignoreSelector: '[data-kma-ignore]',
      inlineStylesheet: true,
      collectFonts: false,
      recordCanvas: false,
      sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last' },
      slimDOMOptions: {
        script: true,
        comment: true,
        headFavicon: true,
        headWhitespace: true,
        headMetaSocial: true,
      },
    })
    return {
      stop: () => stop?.(),
      takeFullSnapshot: () => record.takeFullSnapshot(true),
    }
  },
}
