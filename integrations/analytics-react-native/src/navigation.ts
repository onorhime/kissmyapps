// Screen views from React Navigation, without depending on it: anything with
// getCurrentRoute(), such as the ref from createNavigationContainerRef(), works.

export interface NavigationRefLike {
  getCurrentRoute(): { name: string } | undefined
}

/** Handlers for NavigationContainer's onReady and onStateChange that report each new screen. */
export function navigationTracker(ref: NavigationRefLike, onScreen: (name: string) => void) {
  let last: string | undefined
  const report = () => {
    const name = ref.getCurrentRoute()?.name
    if (!name || name === last) return
    last = name
    onScreen(name)
  }
  return { onReady: report, onStateChange: report }
}
