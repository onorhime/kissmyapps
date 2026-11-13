package com.kissmyapps.reactnative

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import com.android.installreferrer.api.ReferrerDetails
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The optional native part of @kissmyappss/react-native on Android: what the install call
 * needs that JavaScript cannot read. The SDK works without it, minus these fields.
 *
 * - `deviceKey`: SHA-256 hex of Settings.Secure.ANDROID_ID. The ID itself never leaves the phone.
 * - `referrer`, `referrerClickTs`, `installBeginTs`: from the Google Play Install Referrer API,
 *   on install tries only, waiting at most 10 seconds for Google Play (`retryReferrer` then).
 *
 * No advertising ID and no AD_ID permission.
 */
class KissMyAppsAttributionModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

    override fun getName(): String = NAME

    @ReactMethod
    fun getAttributionInfo(request: ReadableMap, promise: Promise) {
        val install = request.hasKey("install") && request.getBoolean("install")
        val info = Arguments.createMap()
        deviceKey()?.let { info.putString("deviceKey", it) }
        if (!install) {
            promise.resolve(info)
            return
        }
        readReferrer(info, promise)
    }

    /** Whether the activity was reopened from Recents: its link then opened the app before. */
    @ReactMethod
    fun launchedFromHistory(promise: Promise) {
        val flags = reactApplicationContext.currentActivity?.intent?.flags ?: 0
        promise.resolve(flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0)
    }

    private fun readReferrer(info: WritableMap, promise: Promise) {
        val client = try {
            InstallReferrerClient.newBuilder(reactApplicationContext).build()
        } catch (error: Exception) {
            null
        }
        if (client == null) {
            promise.resolve(info)
            return
        }
        val answered = AtomicBoolean(false)
        val main = Handler(Looper.getMainLooper())
        // `retry`: Google Play did not answer this time, so the next launch's try asks again.
        fun finish(details: ReferrerDetails?, retry: Boolean) {
            if (!answered.compareAndSet(false, true)) return
            if (details != null) {
                details.installReferrer?.takeIf { it.isNotEmpty() }?.let { info.putString("referrer", it) }
                // Play answers 0 when it does not know.
                val clicked = details.referrerClickTimestampSeconds
                val began = details.installBeginTimestampSeconds
                if (clicked > 0) info.putDouble("referrerClickTs", clicked.toDouble())
                if (began > 0) info.putDouble("installBeginTs", began.toDouble())
            }
            if (retry) info.putBoolean("retryReferrer", true)
            try {
                client.endConnection()
            } catch (ignored: Exception) {
                // Already closed.
            }
            promise.resolve(info)
        }
        main.postDelayed({ finish(null, true) }, REFERRER_WAIT_MS)
        try {
            client.startConnection(object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    when (responseCode) {
                        InstallReferrerClient.InstallReferrerResponse.OK -> {
                            val details = try {
                                client.installReferrer
                            } catch (error: Exception) {
                                null
                            }
                            main.post { finish(details, details == null) }
                        }
                        InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE,
                        InstallReferrerClient.InstallReferrerResponse.SERVICE_DISCONNECTED,
                        -> main.post { finish(null, true) }
                        // No Play Store, or one without the API: asking again will not help.
                        else -> main.post { finish(null, false) }
                    }
                }

                override fun onInstallReferrerServiceDisconnected() {
                    main.post { finish(null, true) }
                }
            })
        } catch (error: Exception) {
            main.post { finish(null, true) }
        }
    }

    @SuppressLint("HardwareIds")
    private fun deviceKey(): String? = try {
        val id = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            Settings.Secure.ANDROID_ID,
        )
        // Some old Android 2.2 phones all share this ID: it says nothing about the device.
        if (id.isNullOrEmpty() || id == SHARED_ANDROID_ID) null else sha256Hex(id)
    } catch (error: Exception) {
        null
    }

    companion object {
        const val NAME = "KissMyAppsAttribution"
        private const val REFERRER_WAIT_MS = 10_000L
        private const val SHARED_ANDROID_ID = "9774d56d682e549c"

        fun sha256Hex(text: String): String =
            MessageDigest.getInstance("SHA-256")
                .digest(text.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
    }
}
