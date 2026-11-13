package com.kissmyapps

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File

/**
 * KissMyApps analytics for Android: sessions, installs, updates, opens, screens and your own
 * events, sent to your KissMyApps project, plus which smart link brought each install and
 * the deep links those links carry.
 *
 * Call [start] once in `Application.onCreate`, then [track], [screen] and [identify] from
 * anywhere. Every call returns at once; the work happens on the SDK's own thread.
 */
object KissMyApps {
    private const val TAG = "KissMyApps"
    private val lock = Any()
    @Volatile private var client: KmaClient? = null
    // Calls made before start run once it is called.
    private val early = ArrayList<(KmaClient) -> Unit>()

    /** Starts the SDK with the project's client key, from Settings > API keys in the console. */
    @JvmStatic
    @JvmOverloads
    fun start(context: Context, key: String, options: KissMyAppsOptions = KissMyAppsOptions()) {
        val pending: List<(KmaClient) -> Unit>
        val started: KmaClient
        synchronized(lock) {
            if (client != null) return
            val application = context.applicationContext as Application
            val (version, build) = appVersion(application)
            val log: (String) -> Unit = { Log.w(TAG, it) }
            val mainThread = Handler(Looper.getMainLooper())
            val platform = Platform(
                store = FileStore(File(application.noBackupFilesDir, "kissmyapps")),
                transport = UrlTransport(),
                scheduler = ExecutorScheduler(log),
                device = { androidDevice(application) },
                sdk = "kma-android/$SDK_VERSION",
                log = log,
                attribution = AndroidAttribution(application),
                main = { task -> mainThread.post { task() } },
            )
            started = KmaClient(
                key,
                options.copy(appVersion = options.appVersion ?: version, build = options.build ?: build),
                platform,
            )
            val lifecycle = AppLifecycle(started)
            application.registerActivityLifecycleCallbacks(lifecycle)
            // Started from an activity that is already on screen.
            if (context is Activity) lifecycle.onActivityStarted(context)
            client = started
            pending = ArrayList(early)
            early.clear()
        }
        pending.forEach { it(started) }
    }

    /** Records something a person did, such as `lesson_completed`, with optional properties. */
    @JvmStatic
    @JvmOverloads
    fun track(name: String, properties: Map<String, Any?> = emptyMap()) = call { it.track(name, properties) }

    /**
     * Records a payment: the amount in major units (9.99, not 999), negative for a refund, and
     * its ISO 4217 currency code. Sent as a `purchase` (or `refund`) event with the reserved
     * properties `kma_revenue` and `kma_currency`. Pass the store's transaction ID, such as
     * Google Play's order ID, so the same payment reported by a RevenueCat or Adapty webhook
     * counts once. An amount that is 0 or over 1,000,000,000 either way, or a currency that is
     * not three letters, sends nothing (with a warning when `debug` is on).
     */
    @JvmStatic
    @JvmOverloads
    fun revenue(
        amount: Double,
        currency: String,
        productId: String? = null,
        transactionId: String? = null,
        event: String? = null,
        properties: Map<String, Any?> = emptyMap(),
    ) = call { it.revenue(amount, currency, productId, transactionId, event, properties) }

    /** Records a screen view; later events carry the screen's name. */
    @JvmStatic
    @JvmOverloads
    fun screen(name: String, properties: Map<String, Any?> = emptyMap()) = call { it.screen(name, properties) }

    /** Ties this install to your own user ID, with optional traits such as email, name or plan. */
    @JvmStatic
    @JvmOverloads
    fun identify(userId: String, traits: Map<String, Any?>? = null) = call { it.identify(userId, traits) }

    /** Updates traits for the current person without changing who they are. */
    @JvmStatic
    fun setTraits(traits: Map<String, Any?>) = call { it.setTraits(traits) }

    /** Forgets the user, for example on sign out: what follows is a new person and session. */
    @JvmStatic
    fun reset() = call { it.reset() }

    /** Stops recording and drops anything not sent yet, until [optIn]. Remembered across launches. */
    @JvmStatic
    fun optOut() = call { it.optOut() }

    @JvmStatic
    fun optIn() = call { it.optIn() }

    /** Sends everything queued now. */
    @JvmStatic
    fun flush() = call { it.flush() }

    /**
     * Hands KissMyApps the link that opened an activity: call it in `onCreate` and
     * `onNewIntent` of the activity your App Links open. The link is matched to its click,
     * and its deep link, if it has one, comes to [onDeepLink]. Returns true when the intent
     * carries an https link, which the SDK sends; false otherwise, such as for an activity
     * reopened from Recents with the link it was first opened with.
     */
    @JvmStatic
    fun handleDeepLink(intent: Intent?): Boolean {
        if (intent == null) return false
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        val url = attributionUrl(intent.dataString) ?: return false
        call { it.handleDeepLink(url) }
        return true
    }

    /**
     * Receives deep links on the main thread, each once: the one an install brought (deferred)
     * and those of links that open the app. One that arrived before a listener was set is
     * handed to the first listener set. Pass null to stop listening.
     */
    @JvmStatic
    fun onDeepLink(listener: DeepLinkListener?) = call { it.onDeepLink(listener) }

    /** The ID of this install's person until [identify], or null before [start]. */
    @JvmStatic
    fun getAnonymousId(): String? = client?.getAnonymousId()

    @JvmStatic
    fun getSessionId(): String? = client?.getSessionId()

    private fun call(run: (KmaClient) -> Unit) {
        val current = client ?: synchronized(lock) {
            client ?: run {
                if (early.size < 100) early.add(run)
                null
            }
        }
        if (current != null) run(current)
    }
}
