package com.kissmyapps

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal const val SDK_VERSION = "1.1.0"
internal val EVENT_NAME = Regex("^[A-Za-z][A-Za-z0-9_.:-]{0,79}$")
private val KEY = Regex("^kma_pk_(live|test)_[A-Za-z0-9]{20,64}$")
private const val BATCH_SIZE = 50
private const val FLUSH_AT = 30
internal const val HEARTBEAT_MS = 60_000L
private const val MAX_PROPERTIES_BYTES = 32_000
internal const val REFERRER_TIMEOUT_MS = 10_000L
private const val MAX_HELD_OPENS = 10

internal fun uuid(): String = UUID.randomUUID().toString()

internal fun isoTime(millis: Long): String {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(Date(millis))
}

private class Session(val id: String, val started: Long, var last: Long, var firstScreen: String?) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("started", started)
        .put("last", last)
        .putIfPresent("firstScreen", firstScreen)

    companion object {
        fun fromJson(json: JSONObject?): Session? {
            if (json == null || !json.has("id")) return null
            return Session(
                json.getString("id"),
                json.getLong("started"),
                json.getLong("last"),
                json.optStringOrNull("firstScreen"),
            )
        }
    }
}

private class QueuedEvent(
    val name: String,
    val insertId: String,
    val time: String,
    val screen: String?,
    val properties: JSONObject,
    val userId: String?,
    val anonymousId: String,
    val sessionId: String,
    val sessionStartedAt: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("name", name)
        .put("insert_id", insertId)
        .put("time", time)
        .putIfPresent("screen", screen)
        .put("properties", properties)
        .put("user_id", userId ?: JSONObject.NULL)
        .put("anonymous_id", anonymousId)
        .put("session_id", sessionId)
        .put("session_started_at", sessionStartedAt)

    /** The event as the request carries it. */
    fun toRequestJson(): JSONObject = JSONObject()
        .put("name", name)
        .put("insert_id", insertId)
        .put("time", time)
        .putIfPresent("screen", screen)
        .put("properties", properties)
        .put("user_id", userId ?: JSONObject.NULL)

    companion object {
        fun fromJson(json: JSONObject) = QueuedEvent(
            json.getString("name"),
            json.getString("insert_id"),
            json.getString("time"),
            json.optStringOrNull("screen"),
            json.optJSONObject("properties") ?: JSONObject(),
            json.optStringOrNull("user_id"),
            json.getString("anonymous_id"),
            json.getString("session_id"),
            json.getString("session_started_at"),
        )
    }
}

private fun JSONObject.putIfPresent(name: String, value: Any?): JSONObject =
    if (value == null) this else put(name, value)

private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) getString(name) else null

/** Turns app values into JSON: maps, lists, numbers, text, booleans, dates and null. */
internal fun toJsonValue(value: Any?): Any = when (value) {
    null -> JSONObject.NULL
    is String, is Boolean, is Int, is Long, is Short, is Byte -> value
    is Double -> if (value.isFinite()) value else JSONObject.NULL
    is Float -> if (value.isFinite()) value.toDouble() else JSONObject.NULL
    is Number -> value.toDouble().let { if (it.isFinite()) it else JSONObject.NULL }
    is Date -> isoTime(value.time)
    is Map<*, *> -> JSONObject().also { json ->
        for ((key, item) in value) if (key != null) json.put(key.toString(), toJsonValue(item))
    }
    is Iterable<*> -> JSONArray().also { array -> value.forEach { array.put(toJsonValue(it)) } }
    is Array<*> -> JSONArray().also { array -> value.forEach { array.put(toJsonValue(it)) } }
    is JSONObject, is JSONArray -> value
    else -> value.toString()
}

/**
 * The SDK's state and rules, shared by every Android entry point. Everything that touches
 * state runs on [Platform.scheduler], one task at a time.
 */
internal class KmaClient(
    val key: String,
    options: KissMyAppsOptions,
    private val platform: Platform,
) {
    val options: KissMyAppsOptions
    private val endpoint: String
    private val storageName: String

    @Volatile private var anonymousId: String = uuid()
    @Volatile private var userId: String? = null
    @Volatile private var session: Session? = null
    private var traits: JSONObject? = null
    private var traitsVersion = 0
    private var optedOut = false
    private var version: String? = null
    private var build: String? = null

    private var queue = ArrayList<QueuedEvent>()
    private var screenName: String? = null
    private var foregroundAt = 0L
    private var flushTask: Cancellable? = null
    private var heartbeatTask: Cancellable? = null
    private var saveTask: Cancellable? = null
    private var failures = 0
    private var lastSent = 0L
    private var identityPending = false
    private var inForeground = false
    private var firstLaunch = false
    @Volatile private var stopped = false
    private val loaded = CountDownLatch(1)

    // Attribution: the install call of the first launch, and links that open the app.
    val deepLinks = DeepLinkRouter(platform.main)
    private var install: PendingInstall? = null
    private var newInstall = false
    private var launched = false
    private var installTried = false
    private var installBusy = false
    private var installSent = false
    private var deviceKey: String? = null
    private var deviceKeyRead = false
    private val heldOpens = ArrayList<Pair<String, Long>>()

    init {
        require(KEY.matches(key)) { "KissMyApps needs a client key that starts with kma_pk_" }
        this.options = options
        endpoint = options.endpoint.trimEnd('/')
        storageName = "kma-${key.takeLast(8)}"
        later { load() }
    }

    // Public API -------------------------------------------------------------------------------

    fun track(name: String, properties: Map<String, Any?>) = later {
        if (stopped || optedOut) return@later
        if (!EVENT_NAME.matches(name)) {
            warn("\"$name\" is not a valid event name: use letters, numbers and _ . : - (up to 80).")
            return@later
        }
        enqueue(name, clean(properties), ensureSession())
    }

    fun screen(name: String, properties: Map<String, Any?>) {
        val screen = name.trim().take(300)
        if (screen.isEmpty()) return warn("screen needs a name.")
        later {
            if (stopped || optedOut) return@later
            val previous = screenName
            screenName = screen
            val current = ensureSession()
            if (current.firstScreen == null) {
                current.firstScreen = screen
                save()
            }
            val values = JSONObject().put("name", screen).putIfPresent("previous", previous)
            val extra = clean(properties)
            for (field in extra.keys()) values.put(field, extra.get(field))
            enqueue("screen_viewed", values, current)
        }
    }

    fun identify(id: String, newTraits: Map<String, Any?>?) {
        val user = id.trim()
        if (user.isEmpty() || user.length > 200) return warn("identify needs a user ID of 1 to 200 characters.")
        later {
            userId = user
            if (newTraits != null) mergeTraits(newTraits)
            identityPending = true
            save()
            scheduleFlush(0)
        }
    }

    fun setTraits(newTraits: Map<String, Any?>) = later {
        mergeTraits(newTraits)
        identityPending = true
        save()
        scheduleFlush(0)
    }

    /** Forgets the user, for example on sign out: what follows is a new person and session. */
    fun reset() = later {
        sendQueued()
        userId = null
        traits = null
        traitsVersion += 1
        identityPending = false
        anonymousId = uuid()
        session = null
        save()
        if (inForeground) ensureSession()
    }

    fun optOut() = later {
        optedOut = true
        queue.clear()
        heldOpens.clear()
        save()
    }

    fun optIn() = later {
        optedOut = false
        save()
        // An install call held back by the opt-out goes now.
        if (launched) startInstall()
    }

    /**
     * A link opened the app. On the first launch it goes with the install call; otherwise
     * it is sent on its own once the launch is under way. False for anything but an https link.
     */
    fun handleDeepLink(url: String): Boolean {
        val link = attributionUrl(url) ?: return false
        val openedAt = platform.now()
        later {
            if (stopped || optedOut) return@later
            val pending = install
            if (newInstall && pending != null && !pending.done && !installSent && pending.linkUrl == null) {
                pending.linkUrl = link
                saveInstall()
                return@later
            }
            if (heldOpens.size < MAX_HELD_OPENS) heldOpens.add(link to openedAt)
            sendHeldOpens()
        }
        return true
    }

    /** Deep links go to this listener on the main thread; one that came earlier is handed over now. */
    fun onDeepLink(listener: DeepLinkListener?) = deepLinks.setListener(listener)

    fun flush() = later { sendQueued() }

    fun getAnonymousId(): String {
        awaitLoad()
        return anonymousId
    }

    fun getUserId(): String? {
        awaitLoad()
        return userId
    }

    fun getSessionId(): String? {
        awaitLoad()
        return session?.id
    }

    /** Runs after everything already asked of the client. */
    fun afterPendingWork(task: () -> Unit) = later(task)

    fun shutdown() = later {
        stopped = true
        inForeground = false
        flushTask?.cancel()
        heartbeatTask?.cancel()
        if (saveTask != null) writeNow()
    }

    // App lifecycle, called by the platform layer --------------------------------------------

    /** The app came to the front. The first call is the launch. */
    fun foreground() = later {
        if (stopped || inForeground) return@later
        val launch = foregroundAt == 0L
        inForeground = true
        foregroundAt = platform.now()
        if (launch) launched = true
        if (optedOut) return@later
        val current = ensureSession()
        if (options.trackLifecycle) {
            if (launch) recordInstallOrUpdate(current)
            enqueue("app_opened", JSONObject().put("from_background", !launch), current)
        }
        if (heartbeatTask == null) scheduleHeartbeat()
        // After app_installed is queued: the install call, then any link that opened the app.
        if (launch) startInstall()
        sendHeldOpens()
    }

    /** The app went to the background: record it and send what is queued while it can. */
    fun background() = later {
        if (stopped || !inForeground) return@later
        inForeground = false
        heartbeatTask?.cancel()
        heartbeatTask = null
        if (optedOut) return@later
        val current = session
        if (current != null && options.trackLifecycle) {
            val seconds = Math.round((platform.now() - foregroundAt) / 1000.0)
            enqueue("app_backgrounded", JSONObject().put("seconds_in_foreground", maxOf(0L, seconds)), current)
        }
        current?.last = platform.now()
        writeNow()
        sendQueued()
    }

    // State ----------------------------------------------------------------------------------

    private fun later(task: () -> Unit) = platform.scheduler.execute(task)

    private fun awaitLoad() {
        try {
            loaded.await(1, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun load() {
        val store = platform.store
        if (store == null) warn("No storage was given, so each launch counts as a new install.")
        var saved: JSONObject? = null
        try {
            saved = store?.read(storageName)?.let { JSONObject(it) }
            val rawQueue = store?.read("$storageName-queue")
            if (rawQueue != null) {
                val array = JSONArray(rawQueue)
                for (index in 0 until array.length()) queue.add(QueuedEvent.fromJson(array.getJSONObject(index)))
            }
        } catch (error: Exception) {
            warn("Saved state could not be read: $error")
            queue.clear()
        }
        val savedId = saved?.optStringOrNull("anonymousId")
        if (saved != null && savedId != null) {
            anonymousId = savedId
            userId = saved.optStringOrNull("userId")
            traits = saved.optJSONObject("traits")
            session = Session.fromJson(saved.optJSONObject("session"))
            optedOut = saved.optBoolean("optedOut", false)
            version = saved.optStringOrNull("version")
            build = saved.optStringOrNull("build")
        }
        // Nothing saved means a first launch, or the app's data was cleared.
        firstLaunch = savedId == null
        identityPending = traits != null
        loadInstall(store)
        loaded.countDown()
        // What an earlier launch could not send goes now.
        if (queue.isNotEmpty()) scheduleFlush(0)
    }

    private fun recordInstallOrUpdate(current: Session) {
        val appVersion = options.appVersion
        val appBuild = options.build
        if (firstLaunch) {
            enqueue(
                "app_installed",
                JSONObject().putIfPresent("version", appVersion).putIfPresent("build", appBuild),
                current,
            )
        } else if (
            (appVersion != null && version != null && appVersion != version) ||
            (appBuild != null && build != null && appBuild != build)
        ) {
            enqueue(
                "app_updated",
                JSONObject()
                    .putIfPresent("version", appVersion)
                    .putIfPresent("build", appBuild)
                    .putIfPresent("previous_version", version)
                    .putIfPresent("previous_build", build),
                current,
            )
        }
        firstLaunch = false
        version = appVersion ?: version
        build = appBuild ?: build
        save()
    }

    private fun save() {
        if (saveTask != null) return
        saveTask = platform.scheduler.schedule(250) {
            saveTask = null
            writeNow()
        }
    }

    private fun writeNow() {
        saveTask?.cancel()
        saveTask = null
        val store = platform.store ?: return
        try {
            val state = JSONObject()
                .put("anonymousId", anonymousId)
                .put("userId", userId ?: JSONObject.NULL)
                .put("traits", traits ?: JSONObject.NULL)
                .put("session", session?.toJson() ?: JSONObject.NULL)
                .put("optedOut", optedOut)
                .putIfPresent("version", version)
                .putIfPresent("build", build)
            store.write(storageName, state.toString())
            store.write("$storageName-queue", JSONArray().also { array -> queue.forEach { array.put(it.toJson()) } }.toString())
        } catch (error: Exception) {
            // Storage full or failing: the client keeps working in memory.
            warn("State could not be saved: $error")
        }
    }

    /** A first launch starts the install call; a later one picks up a call not done yet. */
    private fun loadInstall(store: Store?) {
        newInstall = firstLaunch
        if (newInstall) {
            install = PendingInstall(installedAt = isoTime(platform.now()))
            saveInstall()
            return
        }
        install = try {
            store?.read("$storageName-attribution")?.let { PendingInstall.fromJson(JSONObject(it)) }
        } catch (error: Exception) {
            warn("Saved install attribution could not be read: $error")
            null
        }
    }

    private fun saveInstall() {
        val store = platform.store ?: return
        val pending = install ?: return
        try {
            store.write("$storageName-attribution", pending.toJson().toString())
        } catch (error: Exception) {
            warn("Install attribution could not be saved: $error")
        }
    }

    private fun mergeTraits(newTraits: Map<String, Any?>) {
        val merged = traits?.let { JSONObject(it.toString()) } ?: JSONObject()
        val extra = clean(newTraits)
        for (field in extra.keys()) merged.put(field, extra.get(field))
        traits = merged
        traitsVersion += 1
    }

    // Sessions and events ---------------------------------------------------------------------

    private fun ensureSession(): Session {
        val now = platform.now()
        val timeout = options.sessionTimeoutMinutes * 60_000L
        val current = session
        if (current != null && now - current.last <= timeout) {
            current.last = now
            return current
        }
        val started = Session(uuid(), now, now, screenName)
        session = started
        enqueue("session_started", JSONObject(), started)
        return started
    }

    private fun enqueue(name: String, properties: JSONObject, current: Session) {
        queue.add(
            QueuedEvent(
                name = name,
                insertId = uuid(),
                time = isoTime(platform.now()),
                screen = screenName,
                properties = properties,
                userId = userId,
                anonymousId = anonymousId,
                sessionId = current.id,
                sessionStartedAt = isoTime(current.started),
            ),
        )
        val max = maxOf(1, options.maxQueue)
        if (queue.size > max) queue.subList(0, queue.size - max).clear()
        save()
        scheduleFlush(if (queue.size >= FLUSH_AT) 0 else options.flushIntervalSeconds * 1000L)
    }

    private fun clean(properties: Map<String, Any?>): JSONObject {
        return try {
            val json = toJsonValue(properties) as JSONObject
            if (json.toString().length > MAX_PROPERTIES_BYTES) {
                warn("Event properties are over 32 KB and were dropped.")
                JSONObject()
            } else {
                json
            }
        } catch (_: Exception) {
            JSONObject()
        }
    }

    // Sending --------------------------------------------------------------------------------

    private fun context(live: Session?): JSONObject {
        val device = platform.device()
        return JSONObject()
            .put("platform", device.platform)
            .put("sdk", platform.sdk)
            .put("timezone", device.timezone)
            .put("language", device.language)
            .put("device_type", device.deviceType)
            .putIfPresent("device_model", device.deviceModel)
            .put("os_name", device.osName)
            .put("os_version", device.osVersion)
            .putIfPresent("app_version", options.appVersion)
            .put("screen_width", device.screenWidth)
            .put("screen_height", device.screenHeight)
            .putIfPresent("page_path", live?.firstScreen)
    }

    /** One request's body: queued events share a person and session; with none, a heartbeat. */
    private fun body(events: List<QueuedEvent>): JSONObject {
        val head = events.firstOrNull()
        val current = session
        val sessionId = head?.sessionId ?: current?.id
        val startedAt = head?.sessionStartedAt ?: current?.let { isoTime(it.started) }
        val live = if (current != null && current.id == sessionId) current else null
        val isCurrentPerson = head == null || head.anonymousId == anonymousId
        val user = if (isCurrentPerson) userId else events.last().userId
        val body = JSONObject()
            .put("anonymous_id", head?.anonymousId ?: anonymousId)
            .put("sent_at", isoTime(platform.now()))
            .put("context", context(live))
            .put("events", JSONArray().also { array -> events.forEach { array.put(it.toRequestJson()) } })
        if (sessionId != null) body.put("session", JSONObject().put("id", sessionId).put("started_at", startedAt))
        if (user != null) body.put("user_id", user)
        val currentTraits = traits
        if (isCurrentPerson && currentTraits != null) body.put("traits", currentTraits)
        return body
    }

    private fun nextBatch(): List<QueuedEvent> {
        val head = queue.firstOrNull() ?: return emptyList()
        val batch = ArrayList<QueuedEvent>()
        for (event in queue) {
            if (event.sessionId != head.sessionId || event.anonymousId != head.anonymousId || batch.size >= BATCH_SIZE) break
            batch.add(event)
        }
        return batch
    }

    private fun post(body: JSONObject): Response =
        platform.transport.post("$endpoint/v1/events", key, body.toString())

    private fun sendQueued() {
        while (!stopped && !optedOut) {
            val batch = nextBatch()
            if (batch.isEmpty() && !(identityPending && session != null)) return
            val traitsSent = traitsVersion
            val carriesIdentity = batch.isEmpty() || batch[0].anonymousId == anonymousId
            val response = try {
                post(body(batch))
            } catch (_: Exception) {
                retryLater()
                return
            }
            val refused = refused(response.status)
            val ok = response.status in 200..299
            if (!ok && !refused) {
                retryLater()
                return
            }
            if (refused) warn("Events were refused (${response.status}): ${response.text}")
            val sent = batch.mapTo(HashSet()) { it.insertId }
            queue.removeAll { it.insertId in sent }
            if (ok && carriesIdentity && traitsVersion == traitsSent) {
                traits = null
                identityPending = false
            }
            failures = 0
            lastSent = platform.now()
            save()
        }
    }

    private fun retryLater() {
        failures += 1
        scheduleFlush(minOf(60_000L, 1000L shl minOf(failures, 6)), replace = true)
    }

    private fun scheduleFlush(delay: Long, replace: Boolean = false) {
        if (stopped) return
        val pending = flushTask
        if (pending != null) {
            if (delay > 0 && !replace) return
            pending.cancel()
        }
        flushTask = platform.scheduler.schedule(delay) {
            flushTask = null
            sendQueued()
        }
    }

    private fun scheduleHeartbeat() {
        heartbeatTask = platform.scheduler.schedule(HEARTBEAT_MS) {
            heartbeatTask = null
            if (!inForeground || stopped) return@schedule
            heartbeat()
            scheduleHeartbeat()
        }
    }

    /** Keeps an open app counted as online. */
    private fun heartbeat() {
        val current = session
        if (optedOut || current == null) return
        current.last = platform.now()
        if (queue.isNotEmpty() || identityPending) return sendQueued()
        if (platform.now() - lastSent < HEARTBEAT_MS - 1000) return
        try {
            post(body(emptyList()))
            lastSent = platform.now()
        } catch (_: Exception) {
        }
    }

    private fun refused(status: Int) = status in 400..499 && status != 408 && status != 429

    // Attribution ---------------------------------------------------------------------------

    /** Once per launch while the install call is not done: read the referrer, then send. */
    private fun startInstall() {
        val pending = install ?: return
        if (pending.done || installTried || installBusy || optedOut || stopped) return
        installTried = true
        installBusy = true
        val source = platform.attribution
        if (source == null || pending.referrerRead) return sendInstall()
        var answered = false
        val timeout = platform.scheduler.schedule(REFERRER_TIMEOUT_MS) {
            if (answered) return@schedule
            answered = true
            warn("Google Play's install referrer did not answer in time; the install is sent without it.")
            sendInstall()
        }
        val take: (InstallReferrer?) -> Unit = { details ->
            later {
                if (!answered) {
                    answered = true
                    timeout.cancel()
                    pending.referrer = details
                    pending.referrerRead = true
                    saveInstall()
                    sendInstall()
                }
            }
        }
        try {
            source.installReferrer(take)
        } catch (error: Exception) {
            warn("The install referrer could not be read: $error")
            take(null)
        }
    }

    private fun sendInstall() {
        val pending = install
        if (pending == null || pending.done || stopped || optedOut) return finishInstall()
        // The install belongs to the person and session of its launch, also when it is tried again later.
        val person = pending.anonymousId ?: anonymousId
        val sessionId = pending.sessionId ?: ensureSession().id
        pending.anonymousId = person
        pending.sessionId = sessionId
        val body = installBody(
            anonymousId = person,
            sessionId = sessionId,
            platform = platform.device().platform,
            installedAt = pending.installedAt,
            sdk = platform.sdk,
            userId = if (person == anonymousId) userId else null,
            appVersion = options.appVersion,
            deviceKey = deviceKey(),
            linkUrl = pending.linkUrl,
            referrer = pending.referrer,
        )
        installSent = true
        saveInstall()
        val response = try {
            platform.transport.post("$endpoint/v1/attribution/install", key, body.toString())
        } catch (_: Exception) {
            null
        }
        var answer: AttributionAnswer? = null
        if (response != null && response.status in 200..299) {
            pending.done = true
            answer = parseAttributionAnswer(response.text, pending.linkUrl)
            if (answer == null) warn("The install call's answer could not be read: ${response.text}")
        } else if (response != null && refused(response.status)) {
            pending.done = true
            warn("The install call was refused (${response.status}): ${response.text}")
        } else {
            pending.attempts += 1
            if (pending.attempts >= PendingInstall.MAX_ATTEMPTS) {
                pending.done = true
                warn("The install call failed ${pending.attempts} times and is given up.")
            } else {
                warn("The install call failed; it is tried again on the next launch.")
            }
        }
        saveInstall()
        answer?.deepLink?.let { deepLinks.deliver(it) }
        finishInstall()
    }

    private fun finishInstall() {
        installBusy = false
        sendHeldOpens()
    }

    /** Links wait until the launch is under way and its install call, if any, is answered. */
    private fun sendHeldOpens() {
        if (!launched || installBusy) return
        while (heldOpens.isNotEmpty()) {
            val (url, openedAt) = heldOpens.removeAt(0)
            sendOpen(url, openedAt)
        }
    }

    private fun sendOpen(url: String, openedAt: Long) {
        if (stopped || optedOut) return
        val body = openBody(
            anonymousId = anonymousId,
            sessionId = ensureSession().id,
            platform = platform.device().platform,
            url = url,
            openedAt = isoTime(openedAt),
            sdk = platform.sdk,
            userId = userId,
            appVersion = options.appVersion,
            deviceKey = deviceKey(),
        )
        val response = try {
            platform.transport.post("$endpoint/v1/attribution/open", key, body.toString())
        } catch (error: Exception) {
            return warn("A link open could not be sent: $error")
        }
        if (response.status !in 200..299) return warn("A link open was refused (${response.status}): ${response.text}")
        val answer = parseAttributionAnswer(response.text, url)
            ?: return warn("A link open's answer could not be read: ${response.text}")
        answer.deepLink?.let { deepLinks.deliver(it) }
    }

    private fun deviceKey(): String? {
        if (!deviceKeyRead) {
            deviceKeyRead = true
            deviceKey = try {
                validDeviceKey(platform.attribution?.deviceKey())
            } catch (_: Exception) {
                null
            }
        }
        return deviceKey
    }

    private fun warn(message: String) {
        if (options.debug) platform.log("KissMyApps: $message")
    }
}
