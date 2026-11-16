package com.irfanfrizki.adbwifihelper;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Process;
import android.text.format.DateFormat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Dipicu lewat: adb shell am broadcast -n com.irfanfrizki.adbwifihelper/.UsageReceiver \
 *               -a com.irfanfrizki.adbwifihelper.READ_USAGE
 *
 * Ringkasan hari ini saja (sejak jam 00:00 di HP ini): total waktu layar menyala (kalau
 * didukung versi Androidnya) dan 5 aplikasi dengan waktu pemakaian terbanyak. Selesai dalam
 * hitungan milidetik (query lokal, tanpa menunggu apa pun) -- tidak perlu Service terpisah
 * seperti LocationReceiver.
 *
 * Butuh izin khusus "Usage access" (app-op GET_USAGE_STATS) yang tidak bisa diminta lewat
 * dialog biasa. Diberikan sekali lewat ADB tanpa perlu menyentuh HP-nya:
 *   adb shell appops set com.irfanfrizki.adbwifihelper GET_USAGE_STATS allow
 * Kalau belum diberikan, hasilnya ditulis sebagai {"error":"usage_access_denied"} --
 * backend meneruskan ini sebagai pesan yang jelas, bukan diam-diam gagal.
 */
public class UsageReceiver extends BroadcastReceiver {
    private static final int TOP_N = 5;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!hasUsageAccess(context)) {
            write(context, "{\"error\":\"usage_access_denied\",\"ts\":" + System.currentTimeMillis() + "}");
            return;
        }

        Calendar startOfDay = Calendar.getInstance();
        startOfDay.set(Calendar.HOUR_OF_DAY, 0);
        startOfDay.set(Calendar.MINUTE, 0);
        startOfDay.set(Calendar.SECOND, 0);
        startOfDay.set(Calendar.MILLISECOND, 0);
        long dayStart = startOfDay.getTimeInMillis();
        long now = System.currentTimeMillis();

        UsageStatsManager usm = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        String appsJson = "[]";
        if (usm != null) {
            appsJson = topAppsJson(context, usm, dayStart, now);
        }

        String screenOn = "null";
        if (usm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            long ms = screenOnMillis(usm, dayStart, now);
            if (ms >= 0) screenOn = String.valueOf(ms);
        }

        String date = DateFormat.format("yyyy-MM-dd", now).toString();
        String json = "{\"error\":null"
                + ",\"ts\":" + now
                + ",\"date\":\"" + date + "\""
                + ",\"screen_on_ms\":" + screenOn
                + ",\"apps\":" + appsJson
                + "}";
        write(context, json);
    }

    private boolean hasUsageAccess(Context context) {
        AppOpsManager aom = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (aom == null) return false;
        try {
            int mode;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                mode = aom.unsafeCheckOpNoThrow("android:get_usage_stats", Process.myUid(), context.getPackageName());
            } else {
                mode = aom.checkOpNoThrow("android:get_usage_stats", Process.myUid(), context.getPackageName());
            }
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    /** INTERVAL_DAILY bisa memberi lebih dari satu baris per paket kalau rentang waktu
     *  menyentuh batas bucket internal -- dijumlahkan per paket supaya aman. */
    private String topAppsJson(Context context, UsageStatsManager usm, long start, long end) {
        List<UsageStats> stats;
        try {
            stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end);
        } catch (Exception e) {
            return "[]";
        }
        if (stats == null || stats.isEmpty()) return "[]";

        Map<String, Long> byPkg = new HashMap<>();
        for (UsageStats s : stats) {
            if (s.getTotalTimeInForeground() <= 0) continue;
            Long prev = byPkg.get(s.getPackageName());
            byPkg.put(s.getPackageName(), (prev == null ? 0 : prev) + s.getTotalTimeInForeground());
        }
        List<Map.Entry<String, Long>> sorted = new ArrayList<>(byPkg.entrySet());
        Collections.sort(sorted, new Comparator<Map.Entry<String, Long>>() {
            @Override public int compare(Map.Entry<String, Long> a, Map.Entry<String, Long> b) {
                return Long.compare(b.getValue(), a.getValue());
            }
        });

        PackageManager pm = context.getPackageManager();
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        for (Map.Entry<String, Long> e : sorted) {
            if (n >= TOP_N) break;
            if (n > 0) sb.append(',');
            sb.append("{\"pkg\":\"").append(e.getKey()).append('"')
              .append(",\"label\":\"").append(jsonEscape(labelFor(pm, e.getKey()))).append('"')
              .append(",\"ms\":").append(e.getValue())
              .append('}');
            n++;
        }
        sb.append(']');
        return sb.toString();
    }

    private String labelFor(PackageManager pm, String pkg) {
        try {
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            CharSequence label = pm.getApplicationLabel(info);
            return label == null ? pkg : label.toString();
        } catch (PackageManager.NameNotFoundException e) {
            // Komponen sistem tanpa entri paket biasa (mis. "android") -- tampilkan apa adanya.
            return pkg;
        }
    }

    /** Hanya didukung API 28+ (UsageEvents.Event.SCREEN_INTERACTIVE belum ada di versi lebih
     *  lama -- misalnya Android 7.1.1 di SM-P355). Mengembalikan -1 kalau tidak bisa dihitung. */
    private long screenOnMillis(UsageStatsManager usm, long start, long end) {
        try {
            UsageEvents events = usm.queryEvents(start, end);
            if (events == null) return -1;
            UsageEvents.Event ev = new UsageEvents.Event();
            long total = 0;
            long onSince = -1;
            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                if (ev.getEventType() == UsageEvents.Event.SCREEN_INTERACTIVE) {
                    onSince = ev.getTimeStamp();
                } else if (ev.getEventType() == UsageEvents.Event.SCREEN_NON_INTERACTIVE) {
                    if (onSince >= 0) {
                        total += Math.max(0, ev.getTimeStamp() - onSince);
                        onSince = -1;
                    }
                }
            }
            if (onSince >= 0) {
                // Layar masih menyala saat query dijalankan -- hitung sampai sekarang juga.
                total += Math.max(0, end - onSince);
            }
            return total;
        } catch (Exception e) {
            return -1;
        }
    }

    private String jsonEscape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private void write(Context context, String json) {
        try {
            File dir = context.getExternalFilesDir(null);
            if (dir == null) return;
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, "usage.json");
            File tmp = new File(dir, "usage.json.tmp");
            FileOutputStream fos = new FileOutputStream(tmp);
            try {
                fos.write(json.getBytes(StandardCharsets.UTF_8));
            } finally {
                fos.close();
            }
            tmp.renameTo(out);
        } catch (IOException ignored) {
            // Diam -- backend akan menganggap "belum ada hasil" kalau penulisan gagal.
        }
    }
}
