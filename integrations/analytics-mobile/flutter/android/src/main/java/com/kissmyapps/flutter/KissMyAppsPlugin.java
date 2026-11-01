package com.kissmyapps.flutter;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.res.Resources;
import android.os.Build;
import android.util.DisplayMetrics;

import androidx.annotation.NonNull;

import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;

import java.io.File;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/** Tells the Dart side about the device and the app, the same way the Android SDK does. */
public final class KissMyAppsPlugin implements FlutterPlugin, MethodChannel.MethodCallHandler {
    private MethodChannel channel;
    private Context context;

    @Override
    public void onAttachedToEngine(@NonNull FlutterPluginBinding binding) {
        context = binding.getApplicationContext();
        channel = new MethodChannel(binding.getBinaryMessenger(), "kissmyapps");
        channel.setMethodCallHandler(this);
    }

    @Override
    public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) {
        channel.setMethodCallHandler(null);
        channel = null;
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
            default:
                result.notImplemented();
        }
    }

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
