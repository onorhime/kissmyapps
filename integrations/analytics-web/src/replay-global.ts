import { replay } from './replay'

// The script-tag build loads this file on demand and picks the recorder up from here.
;(window as Window & { __kmaReplay?: typeof replay }).__kmaReplay = replay
