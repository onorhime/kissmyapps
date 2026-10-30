package com.kissmyapps

/** Settings for [KissMyApps.start]. Every one has a default. */
data class KissMyAppsOptions @JvmOverloads constructor(
    /** The app's version and build number. Read from the app's package when left out. */
    val appVersion: String? = null,
    val build: String? = null,
    val endpoint: String = DEFAULT_ENDPOINT,
    /** A session ends after this long in the background or without events. */
    val sessionTimeoutMinutes: Int = 30,
    /** How often queued events are sent while the app is open. */
    val flushIntervalSeconds: Int = 10,
    /** The most events kept while offline; the oldest go first. */
    val maxQueue: Int = 1000,
    /** Record installs, updates, opens and backgrounding. */
    val trackLifecycle: Boolean = true,
    /** Log refused events and other problems to Logcat. */
    val debug: Boolean = false,
) {
    companion object {
        const val DEFAULT_ENDPOINT = "https://events.kissmyapps.dev"
    }
}
