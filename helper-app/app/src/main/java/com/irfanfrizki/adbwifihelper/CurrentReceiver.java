package com.irfanfrizki.adbwifihelper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.BatteryManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Dipicu lewat: adb shell am broadcast -n com.irfanfrizki.adbwifihelper/.CurrentReceiver \
 *               -a com.irfanfrizki.adbwifihelper.READ_CURRENT
 *
 * Membaca BatteryManager.BATTERY_PROPERTY_CURRENT_NOW/AVERAGE (API sistem Android,
 * tersedia untuk proses aplikasi biasa -- tidak sama dengan /sys/class/power_supply/.../
 * current_now yang sering ditolak SELinux untuk proses adb shell/root-kernel langsung di
 * Android 10+), lalu tulis hasilnya sebagai JSON kecil ke getExternalFilesDir(), yang bisa
 * dibaca ulang lewat `adb shell cat` tanpa run-as dan tanpa izin tambahan apa pun.
 */
public class CurrentReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int nowUa = Integer.MIN_VALUE;
        int avgUa = Integer.MIN_VALUE;
        BatteryManager bm = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        if (bm != null) {
            try {
                nowUa = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
            } catch (Exception ignored) {
                // Properti tidak didukung di perangkat ini -- tetap Integer.MIN_VALUE.
            }
            try {
                avgUa = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE);
            } catch (Exception ignored) {
                // sama seperti di atas
            }
        }

        String nowStr = (nowUa == Integer.MIN_VALUE) ? "null" : String.valueOf(nowUa);
        String avgStr = (avgUa == Integer.MIN_VALUE) ? "null" : String.valueOf(avgUa);
        String json = "{\"current_now_ua\":" + nowStr
                + ",\"current_avg_ua\":" + avgStr
                + ",\"ts\":" + System.currentTimeMillis()
                + "}";

        try {
            File dir = context.getExternalFilesDir(null);
            if (dir != null) {
                if (!dir.exists()) {
                    dir.mkdirs();
                }
                File out = new File(dir, "current.json");
                // Tulis ke file sementara lalu rename -- supaya backend yang sedang
                // membaca tidak pernah melihat file setengah-tertulis.
                File tmp = new File(dir, "current.json.tmp");
                FileOutputStream fos = new FileOutputStream(tmp);
                try {
                    fos.write(json.getBytes(StandardCharsets.UTF_8));
                } finally {
                    fos.close();
                }
                tmp.renameTo(out);
            }
        } catch (IOException ignored) {
            // Diam -- kalau gagal tulis, backend akan menganggap "tidak tersedia"
            // karena file lama/tidak ada, bukan meng-crash receiver ini.
        }
    }
}
