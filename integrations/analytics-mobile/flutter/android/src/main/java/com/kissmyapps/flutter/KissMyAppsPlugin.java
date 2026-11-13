package com.kissmyapps.flutter;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.res.Resources;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;

import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.embedding.engine.plugins.activity.ActivityAware;
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding;
import io.flutter.plugin.common.EventChannel;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;
import io.flutter.plugin.common.PluginRegistry;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Tells the Dart side about the device and the app, the same way the Android SDK does; reads
 * what install attribution needs (the device key and the Google Play install referrer); and
 * passes on the App Links that open the app.
 */
public final class KissMyAppsPlugin implements FlutterPlugin, MethodChannel.MethodCallHandler,
        ActivityAware, PluginRegistry.NewIntentListener, EventChannel.StreamHandler {
    // Some old Android 2.2 phones all share this ID: it says nothing about the device.
    private static final String SHARED_ANDROID_ID = "9774d56d682e549c";
    private static final long REFERRER_WAIT_MS = 10_000L;
    private static final int MAX_WAITING_LINKS = 10;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MethodChannel channel;
    private EventChannel links;
    private Context context;
    @Nullable private ActivityPluginBinding activity;
    @Nullable private EventChannel.EventSink sink;
    // Links that came before the Dart side listened.
    private final List<String> waiting = new ArrayList<>();
    // The link that opened the activity, kept until the Dart side asks for it once.
    @Nullable private String launchLink;
    private boolean launchLinkRead;

    @Override
    public void onAttachedToEngine(@NonNull FlutterPluginBinding binding) {
        context = binding.getApplicationContext();
        channel = new MethodChannel(binding.getBinaryMessenger(), "kissmyapps");
        channel.setMethodCallHandler(this);
        links = new EventChannel(binding.getBinaryMessenger(), "kissmyapps/links");
        links.setStreamHandler(this);
    }

    @Override
    public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) {
        channel.setMethodCallHandler(null);
        links.setStreamHandler(null);
        channel = null;
        links = null;
        sink = null;
        context = null;
    }

    @Override
    public void onMethodCall(@NonNull MethodCall call, @NonNull MethodChannel.Result result) {
        switch (call.method) {
            case "info":
                try {
                    result.success(info());
                } catch (Exception error) {
                    result.error("info", error.getMessage(), null);
                }
                break;
            case "releaseBackground":
                // Android keeps the process running after the app leaves the screen.
                result.success(null);
                break;
            case "initialLink":
                launchLinkRead = true;
                result.success(launchLink);
                launchLink = null;
                break;
            case "attributionInfo":
                attributionInfo(Boolean.TRUE.equals(call.argument("install")), result);
                break;
            default:
                result.notImplemented();
        }
    }

    // Links ----------------------------------------------------------------------------------

    @Override
    public void onAttachedToActivity(@NonNull ActivityPluginBinding binding) {
        attach(binding);
        Activity current = binding.getActivity();
        String link = linkFrom(current.getIntent());
        if (link == null) return;
        // An engine that started before the activity has already asked for the opening link.
        if (launchLinkRead) {
            send(link);
        } else {
            launchLink = link;
        }
    }

    @Override
    public void onReattachedToActivityForConfigChanges(@NonNull ActivityPluginBinding binding) {
        // The same activity after a rotation: its link was already passed on.
        attach(binding);
    }

    @Override
    public void onDetachedFromActivityForConfigChanges() {
        detach();
    }

    @Override
    public void onDetachedFromActivity() {
        detach();
    }

    private void attach(ActivityPluginBinding binding) {
        activity = binding;
        binding.addOnNewIntentListener(this);
    }

    private void detach() {
        if (activity != null) activity.removeOnNewIntentListener(this);
        activity = null;
    }

    @Override
    public boolean onNewIntent(@NonNull Intent intent) {
        String link = linkFrom(intent);
        if (link != null) send(link);
        // Other plugins and the app still get the intent.
        return false;
    }

    /** An App Link's address, unless the activity was reopened from Recents with an old one. */
    @Nullable
    private static String linkFrom(@Nullable Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;
        Uri data = intent.getData();
        return data == null ? null : data.toString();
    }

    private void send(String link) {
        if (sink != null) {
            sink.success(link);
        } else if (waiting.size() < MAX_WAITING_LINKS) {
            waiting.add(link);
        }
    }

    @Override
    public void onListen(Object arguments, EventChannel.EventSink events) {
        sink = events;
        for (String link : waiting) events.success(link);
        waiting.clear();
    }

    @Override
    public void onCancel(Object arguments) {
        sink = null;
    }

    // Attribution ----------------------------------------------------------------------------

    /**
     * The device key, and on install tries the Google Play install referrer, waiting at most 10
     * seconds for Google Play (then `retryReferrer`, so the next try asks again).
     */
    private void attributionInfo(boolean install, MethodChannel.Result result) {
        final Map<String, Object> info = new HashMap<>();
        String key = deviceKey();
        if (key != null) info.put("deviceKey", key);
        if (!install) {
            result.success(info);
            return;
        }
        final InstallReferrerClient client;
        try {
            client = InstallReferrerClient.newBuilder(context).build();
        } catch (Exception error) {
            result.success(info);
            return;
        }
        final AtomicBoolean answered = new AtomicBoolean(false);
        final ReferrerAnswer finish = (details, retry) -> {
            if (!answered.compareAndSet(false, true)) return;
            if (details != null) {
                String referrer = details.getInstallReferrer();
                if (referrer != null && !referrer.isEmpty()) info.put("referrer", referrer);
                // Play answers 0 when it does not know.
                long clicked = details.getReferrerClickTimestampSeconds();
                long began = details.getInstallBeginTimestampSeconds();
                if (clicked > 0) info.put("referrerClickTs", clicked);
                if (began > 0) info.put("installBeginTs", began);
            }
            if (retry) info.put("retryReferrer", true);
            try {
                client.endConnection();
            } catch (Exception ignored) {
                // Already closed.
            }
            result.success(info);
        };
        main.postDelayed(() -> finish.answer(null, true), REFERRER_WAIT_MS);
        try {
            client.startConnection(new InstallReferrerStateListener() {
                @Override
                public void onInstallReferrerSetupFinished(int responseCode) {
                    if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                        ReferrerDetails details;
                        try {
                            details = client.getInstallReferrer();
                        } catch (Exception error) {
                            details = null;
                        }
                        final ReferrerDetails read = details;
                        main.post(() -> finish.answer(read, read == null));
                    } else if (responseCode == InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE
                            || responseCode == InstallReferrerClient.InstallReferrerResponse.SERVICE_DISCONNECTED) {
                        main.post(() -> finish.answer(null, true));
                    } else {
                        // No Play Store, or one without the API: asking again will not help.
                        main.post(() -> finish.answer(null, false));
                    }
                }

                @Override
                public void onInstallReferrerServiceDisconnected() {
                    main.post(() -> finish.answer(null, true));
                }
            });
        } catch (Exception error) {
            main.post(() -> finish.answer(null, true));
        }
    }

    private interface ReferrerAnswer {
        void answer(@Nullable ReferrerDetails details, boolean retry);
    }

    /** SHA-256 hex of ANDROID_ID. The ID itself never leaves the phone. */
    @SuppressLint("HardwareIds")
    @Nullable
    private String deviceKey() {
        try {
            String id = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
            if (id == null || id.isEmpty() || SHARED_ANDROID_ID.equals(id)) return null;
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } catch (Exception error) {
            return null;
        }
    }

    // Device ---------------------------------------------------------------------------------

    private Map<String, Object> info() {
        Map<String, Object> info = new HashMap<>();
        Resources resources = context.getResources();
        DisplayMetrics metrics = resources.getDisplayMetrics();
        info.put("osName", "Android");
        info.put("osVersion", Build.VERSION.RELEASE != null ? Build.VERSION.RELEASE : String.valueOf(Build.VERSION.SDK_INT));
        info.put("deviceType", resources.getConfiguration().smallestScreenWidthDp >= 600 ? "tablet" : "mobile");
        info.put("deviceModel", Build.MODEL);
        info.put("screenWidth", Math.round(metrics.widthPixels / metrics.density));
        info.put("screenHeight", Math.round(metrics.heightPixels / metrics.density));
        info.put("timezone", TimeZone.getDefault().getID());
        info.put("language", Locale.getDefault().toLanguageTag());
        try {
            @SuppressWarnings("deprecation")
            PackageInfo app = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            info.put("appVersion", app.versionName);
            if (Build.VERSION.SDK_INT >= 28) {
                info.put("build", String.valueOf(app.getLongVersionCode()));
            } else {
                info.put("build", String.valueOf(versionCode(app)));
            }
        } catch (Exception ignored) {
            // The version stays unknown.
        }
        // Left out of backups, so a restored phone counts as a new install.
        File directory = new File(context.getNoBackupFilesDir(), "kissmyapps");
        //noinspection ResultOfMethodCallIgnored
        directory.mkdirs();
        info.put("storageDirectory", directory.getAbsolutePath());
        return info;
    }

    @SuppressWarnings("deprecation")
    private static int versionCode(PackageInfo app) {
        return app.versionCode;
    }
}
