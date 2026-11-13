package com.kissmyapps

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import java.util.concurrent.atomic.AtomicBoolean

/**
 * What only Android knows about the install: the device key, a SHA-256 of
 * `Settings.Secure.ANDROID_ID` worked out here (the ID itself never leaves the phone), and
 * Google Play's install referrer. The core asks for the referrer once, on the first launch.
 */
internal class AndroidAttribution(context: Context) : AttributionSource {
    private val context = context.applicationContext
    private val mainThread = Handler(Looper.getMainLooper())

    @SuppressLint("HardwareIds")
    override fun deviceKey(): String? = try {
        deviceKeyFor(Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID))
    } catch (_: Exception) {
        null
    }

    /** Connects to Google Play, reads the referrer and ends the connection; answers once. */
    override fun installReferrer(done: (InstallReferrer?) -> Unit) {
        val answered = AtomicBoolean(false)
        val answer: (InstallReferrer?) -> Unit = { details ->
            if (answered.compareAndSet(false, true)) done(details)
        }
        mainThread.post {
            val client = try {
                InstallReferrerClient.newBuilder(context).build()
            } catch (_: Exception) {
                null
            } catch (_: LinkageError) {
                null
            }
            if (client == null) {
                answer(null)
                return@post
            }
            val listener = object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    // FEATURE_NOT_SUPPORTED (no Play Store, or one too old), SERVICE_UNAVAILABLE
                    // and the other codes: the install is sent without a referrer.
                    val details = if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) read(client) else null
                    end(client)
                    answer(details)
                }

                override fun onInstallReferrerServiceDisconnected() {
                    end(client)
                    answer(null)
                }
            }
            try {
                client.startConnection(listener)
            } catch (_: Exception) {
                end(client)
                answer(null)
            }
        }
    }

    private fun read(client: InstallReferrerClient): InstallReferrer? = try {
        val details = client.installReferrer
        InstallReferrer(
            referrer = details.installReferrer,
            referrerClickTimestampSeconds = details.referrerClickTimestampSeconds,
            installBeginTimestampSeconds = details.installBeginTimestampSeconds,
        )
    } catch (_: Exception) {
        null
    }

    private fun end(client: InstallReferrerClient) {
        try {
            client.endConnection()
        } catch (_: Exception) {
        }
    }
}
