package com.kissmyapps

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToInt

internal fun androidDevice(context: Context): DeviceInfo {
    val resources = context.resources
    val metrics = resources.displayMetrics
    return DeviceInfo(
        platform = "android",
        osName = "Android",
        osVersion = Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString(),
        deviceType = if (resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "mobile",
        deviceModel = Build.MODEL,
        screenWidth = (metrics.widthPixels / metrics.density).roundToInt(),
        screenHeight = (metrics.heightPixels / metrics.density).roundToInt(),
        timezone = TimeZone.getDefault().id,
        language = Locale.getDefault().toLanguageTag(),
    )
}

/** The app's version name and build number, from its package. */
internal fun appVersion(context: Context): Pair<String?, String?> {
    return try {
        @Suppress("DEPRECATION")
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val build = if (Build.VERSION.SDK_INT >= 28) {
            info.longVersionCode.toString()
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toString()
        }
        info.versionName to build
    } catch (_: Exception) {
        null to null
    }
}

/**
 * Follows the app between foreground and background: it is in the foreground while any of
 * its activities is started. Rotating the screen restarts an activity without leaving.
 */
internal class AppLifecycle(private val client: KmaClient) : Application.ActivityLifecycleCallbacks {
    private val started = HashSet<Int>()

    override fun onActivityStarted(activity: Activity) {
        started.add(System.identityHashCode(activity))
        client.foreground()
    }

    override fun onActivityStopped(activity: Activity) {
        started.remove(System.identityHashCode(activity))
        if (started.isEmpty() && !activity.isChangingConfigurations) client.background()
    }

    override fun onActivityDestroyed(activity: Activity) {
        started.remove(System.identityHashCode(activity))
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

    override fun onActivityResumed(activity: Activity) {}

    override fun onActivityPaused(activity: Activity) {}

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
}
