package com.irfanfrizki.adbwifihelper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Dipicu lewat: adb shell am broadcast -n com.irfanfrizki.adbwifihelper/.LocationReceiver \
 *               -a com.irfanfrizki.adbwifihelper.READ_LOCATION
 *
 * Mengambil lokasi butuh menunggu hasil GPS/jaringan (bisa belasan detik) -- terlalu lama
 * untuk dikerjakan langsung di BroadcastReceiver.onReceive() (dibatasi OS, berisiko ANR).
 * Receiver ini hanya meneruskan ke LocationFetchService, yang menampilkan notifikasi
 * (supaya terlihat di HP ini selama proses berlangsung -- tidak diam-diam) lalu
 * mengerjakan permintaan lokasi di sana.
 */
public class LocationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Intent svc = new Intent(context, LocationFetchService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(svc);
        } else {
            context.startService(svc);
        }
    }
}
