package com.kissmyapps

import org.json.JSONObject
import java.security.MessageDigest

// Install attribution and deep links: the bodies of /v1/attribution/install and
// /v1/attribution/open, their answer, and handing deep links to the app. The rules are in
// integrations/analytics-mobile/contract/app-events.json, under "attribution".

/** A deep link from one of your KissMyApps smart links, handed to [DeepLinkListener] once. */
data class DeepLink(
    /** The link's deep link value, such as `lesson`, or null when the link has none. */
    val value: String?,
    /** The link's deep link parameters, such as `id` = `4`. */
    val params: Map<String, String>,
    /** True when it reached the app through an install (a deferred deep link), false when a link opened the app. */
    val deferred: Boolean,
    /** The link that opened the app, or null when the deep link came through the store. */
    val url: String?,
)

/** Receives deep links on the main thread. Set it with `KissMyApps.onDeepLink`. */
fun interface DeepLinkListener {
    fun onDeepLink(deepLink: DeepLink)
}

/** What Google Play's Install Referrer API says about this install. */
internal class InstallReferrer(
    val referrer: String?,
    val referrerClickTimestampSeconds: Long,
    val installBeginTimestampSeconds: Long,
)

/** Install facts only the platform can read. */
internal interface AttributionSource {
    /** Lowercase hex SHA-256 of the device's app-scoped ID, or null. Never the ID itself. */
    fun deviceKey(): String?

    /** Reads the install referrer and answers once, on any thread: null when there is none. */
    fun installReferrer(done: (InstallReferrer?) -> Unit)
}

internal const val MAX_LINK_LENGTH = 2048
internal const val MAX_REFERRER_LENGTH = 1024
private const val MAX_DEEP_LINK_PARAMS = 10
private val DEVICE_KEY = Regex("^[0-9a-f]{64}$")
private val HTTPS_URL = Regex("^https://[^/?#\\s]+.*$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

// A value some early Android builds gave every device; it identifies nothing.
private const val SHARED_ANDROID_ID = "9774d56d682e549c"

/** An https link the attribution calls accept (at most 2,048 characters), or null. */
internal fun attributionUrl(url: String?): String? {
    val link = url?.trim() ?: return null
    if (link.length > MAX_LINK_LENGTH || !HTTPS_URL.matches(link)) return null
    return link
}

private const val HEX = "0123456789abcdef"

internal fun sha256Hex(text: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
    val out = StringBuilder(digest.size * 2)
    for (byte in digest) {
        val value = byte.toInt() and 0xff
        out.append(HEX[value shr 4]).append(HEX[value and 0x0f])
    }
    return out.toString()
}

/** The device key for an app-scoped device ID such as `Settings.Secure.ANDROID_ID`, or null. */
internal fun deviceKeyFor(id: String?): String? {
    val raw = id?.trim()
    if (raw.isNullOrEmpty() || raw.equals(SHARED_ANDROID_ID, ignoreCase = true)) return null
    return sha256Hex(raw)
}

internal fun validDeviceKey(key: String?): String? = key?.takeIf { DEVICE_KEY.matches(it) }

/**
 * Adds Play's install referrer as the contract names it. A timestamp Play does not know
 * comes back as 0 and is left out: an install_begin_ts of 0 would read as a click after
 * the install.
 */
internal fun JSONObject.putReferrer(details: InstallReferrer?): JSONObject {
    if (details == null) return this
    val referrer = details.referrer?.trim()
    if (!referrer.isNullOrEmpty()) put("referrer", referrer.take(MAX_REFERRER_LENGTH))
    if (details.referrerClickTimestampSeconds > 0) put("referrer_click_ts", details.referrerClickTimestampSeconds)
    if (details.installBeginTimestampSeconds > 0) put("install_begin_ts", details.installBeginTimestampSeconds)
    return this
}

private fun JSONObject.putText(name: String, value: String?): JSONObject =
    if (value.isNullOrEmpty()) this else put(name, value)

/** The body of POST /v1/attribution/install. */
internal fun installBody(
    anonymousId: String,
    sessionId: String,
    platform: String,
    installedAt: String,
    sdk: String,
    userId: String? = null,
    appVersion: String? = null,
    deviceKey: String? = null,
    linkUrl: String? = null,
    referrer: InstallReferrer? = null,
): JSONObject = JSONObject()
    .put("anonymous_id", anonymousId)
    .put("session_id", sessionId)
    .put("platform", platform)
    .put("installed_at", installedAt)
    .put("sdk", sdk)
    .putText("user_id", userId)
    .putText("app_version", appVersion)
    .putText("device_key", validDeviceKey(deviceKey))
    .putText("link_url", attributionUrl(linkUrl))
    .putReferrer(referrer)

/** The body of POST /v1/attribution/open. */
internal fun openBody(
    anonymousId: String,
    sessionId: String,
    platform: String,
    url: String,
    openedAt: String,
    sdk: String,
    userId: String? = null,
    appVersion: String? = null,
    deviceKey: String? = null,
): JSONObject = JSONObject()
    .put("anonymous_id", anonymousId)
    .put("session_id", sessionId)
    .put("platform", platform)
    .put("url", url)
    .put("opened_at", openedAt)
    .put("sdk", sdk)
    .putText("user_id", userId)
    .putText("app_version", appVersion)
    .putText("device_key", validDeviceKey(deviceKey))

/** The answer of both calls. */
internal class AttributionAnswer(
    val matched: Boolean,
    val method: String,
    val source: String?,
    val campaign: String?,
    val channel: String?,
    val adset: String?,
    val ad: String?,
    val reinstall: Boolean,
    /** The deep link without its url; the caller knows which link, if any, opened the app. */
    val deepLink: DeepLink?,
)

private fun JSONObject.textOrNull(name: String): String? =
    if (has(name) && !isNull(name)) opt(name)?.toString() else null

/** Reads an answer; null when it is not one. */
internal fun parseAttributionAnswer(text: String, url: String? = null): AttributionAnswer? {
    return try {
        val json = JSONObject(text)
        if (!json.has("matched") || !json.has("method") || !json.has("deep_link")) return null
        val method = json.textOrNull("method") ?: return null
        AttributionAnswer(
            matched = json.optBoolean("matched", false),
            method = method,
            source = json.textOrNull("source"),
            campaign = json.textOrNull("campaign"),
            channel = json.textOrNull("channel"),
            adset = json.textOrNull("adset"),
            ad = json.textOrNull("ad"),
            reinstall = json.optBoolean("reinstall", false),
            deepLink = json.optJSONObject("deep_link")?.let { parseDeepLink(it, url) },
        )
    } catch (_: Exception) {
        null
    }
}

private fun parseDeepLink(json: JSONObject, url: String?): DeepLink {
    val params = LinkedHashMap<String, String>()
    val raw = json.optJSONObject("params")
    if (raw != null) {
        for (name in raw.keys().asSequence().sorted()) {
            if (params.size >= MAX_DEEP_LINK_PARAMS) break
            val value = raw.opt(name)
            if (value is String || value is Number || value is Boolean) params[name] = value.toString()
        }
    }
    return DeepLink(
        value = json.textOrNull("value"),
        params = params,
        deferred = json.optBoolean("deferred", false),
        url = url,
    )
}

/**
 * Hands each deep link to the app's listener once, on the main thread. One that arrives
 * before a listener is set waits (the newest only) and goes to the first listener set.
 */
internal class DeepLinkRouter(private val main: (() -> Unit) -> Unit) {
    private var listener: DeepLinkListener? = null
    private var held: DeepLink? = null

    fun setListener(next: DeepLinkListener?) {
        val waiting: DeepLink?
        synchronized(this) {
            listener = next
            waiting = if (next != null) held else null
            if (waiting != null) held = null
        }
        if (next != null && waiting != null) main { next.onDeepLink(waiting) }
    }

    fun deliver(link: DeepLink) {
        val current = synchronized(this) {
            listener.also { if (it == null) held = link }
        }
        if (current != null) main { current.onDeepLink(link) }
    }
}

/**
 * The install call, kept on disk until it is done: created on the first launch, sent once,
 * and on a network failure tried again on each of the next launches, up to 3 more times.
 */
internal class PendingInstall(
    val installedAt: String,
    var anonymousId: String? = null,
    var sessionId: String? = null,
    var linkUrl: String? = null,
    var referrerRead: Boolean = false,
    var referrer: InstallReferrer? = null,
    var attempts: Int = 0,
    var done: Boolean = false,
) {
    fun toJson(): JSONObject {
        val json = JSONObject()
            .put("installedAt", installedAt)
            .putText("anonymousId", anonymousId)
            .putText("sessionId", sessionId)
            .putText("linkUrl", linkUrl)
            .put("referrerRead", referrerRead)
            .put("attempts", attempts)
            .put("done", done)
        val details = referrer
        if (details != null) {
            json.put(
                "referrer",
                JSONObject()
                    .putText("referrer", details.referrer)
                    .put("clickSeconds", details.referrerClickTimestampSeconds)
                    .put("beginSeconds", details.installBeginTimestampSeconds),
            )
        }
        return json
    }

    companion object {
        const val MAX_ATTEMPTS = 4

        fun fromJson(json: JSONObject): PendingInstall? {
            val installedAt = json.textOrNull("installedAt") ?: return null
            val details = json.optJSONObject("referrer")?.let {
                InstallReferrer(it.textOrNull("referrer"), it.optLong("clickSeconds"), it.optLong("beginSeconds"))
            }
            return PendingInstall(
                installedAt = installedAt,
                anonymousId = json.textOrNull("anonymousId"),
                sessionId = json.textOrNull("sessionId"),
                linkUrl = json.textOrNull("linkUrl"),
                referrerRead = json.optBoolean("referrerRead", false),
                referrer = details,
                attempts = json.optInt("attempts", 0),
                done = json.optBoolean("done", false),
            )
        }
    }
}
