package com.irfanfrizki.adbwifihelper;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Service latar singkat (berjalan beberapa detik, lalu berhenti sendiri) yang menampilkan
 * notifikasi "adbWIFI: mengambil lokasi..." selama mengambil satu titik lokasi, lalu menulis
 * hasilnya ke getExternalFilesDir()/location.json dan berhenti. Tidak melacak lokasi terus-
 * menerus -- hanya dipicu sekali tiap kali aplikasi kontroler meminta (lihat README).
 */
public class LocationFetchService extends Service implements LocationListener {

    private static final String CHANNEL_ID = "adbwifi_helper_location";
    private static final int NOTIF_ID = 1001;
    private static final long TIMEOUT_MS = 15000;

    private LocationManager lm;
    private Handler handler;
    private Runnable timeoutRunnable;
    private boolean done = false;

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "adbWIFI - lokasi", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Muncul sebentar saat aplikasi adbWIFI meminta lokasi HP ini.");
                nm.createNotificationChannel(ch);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification n = b.setContentTitle("adbWIFI")
                .setContentText("Mengambil lokasi HP ini...")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .build();
        startForeground(NOTIF_ID, n);

        boolean granted = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                || hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION);
        if (!granted) {
            writeError("permission_denied");
            finishUp();
            return START_NOT_STICKY;
        }

        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        String provider = pickProvider();
        if (provider == null) {
            // GPS dan jaringan sama-sama mati: coba titik terakhir yang pernah tercatat,
            // kalau tidak ada juga baru menyerah.
            Location last = bestLastKnown();
            if (last != null) writeResult(last, true);
            else writeError("location_disabled");
            finishUp();
            return START_NOT_STICKY;
        }

        try {
            lm.requestSingleUpdate(provider, this, Looper.getMainLooper());
        } catch (SecurityException | IllegalArgumentException e) {
            writeError("permission_denied");
            finishUp();
            return START_NOT_STICKY;
        }
        timeoutRunnable = new Runnable() {
            @Override public void run() { onTimeout(); }
        };
        handler.postDelayed(timeoutRunnable, TIMEOUT_MS);
        return START_NOT_STICKY;
    }

    private boolean hasPermission(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** GPS lebih akurat -> diutamakan kalau menyala; jaringan dipakai kalau GPS mati. */
    private String pickProvider() {
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) return LocationManager.GPS_PROVIDER;
        } catch (Exception ignored) { /* provider tidak ada di HP ini */ }
        try {
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER;
        } catch (Exception ignored) { /* sama */ }
        return null;
    }

    private Location bestLastKnown() {
        Location best = null;
        for (String p : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (SecurityException ignored) { /* izin belum ada -- sudah dicek di atas, jaga-jaga */ }
        }
        return best;
    }

    @Override
    public void onLocationChanged(Location location) {
        if (done) return;
        cancelTimeout();
        safeRemoveUpdates();
        writeResult(location, false);
        finishUp();
    }

    private void onTimeout() {
        if (done) return;
        safeRemoveUpdates();
        Location last = bestLastKnown();
        if (last != null) writeResult(last, true);
        else writeError("timeout");
        finishUp();
    }

    private void cancelTimeout() {
        if (timeoutRunnable != null) handler.removeCallbacks(timeoutRunnable);
    }

    private void safeRemoveUpdates() {
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) { /* abaikan */ }
    }

    private void finishUp() {
        done = true;
        cancelTimeout();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    /** stale=true berarti titik ini bukan dari fix baru (GPS/jaringan tidak sempat menjawab
     *  dalam {@link #TIMEOUT_MS}), melainkan posisi terakhir yang pernah tercatat -- age_s
     *  memberi tahu klien seberapa basi. */
    private void writeResult(Location loc, boolean stale) {
        long nowMs = System.currentTimeMillis();
        long ageS = stale ? Math.max(0, (nowMs - loc.getTime()) / 1000) : 0;
        String acc = loc.hasAccuracy() ? String.format(Locale.US, "%.1f", loc.getAccuracy()) : "null";
        String json = "{\"error\":null"
                + ",\"ts\":" + nowMs
                + ",\"lat\":" + String.format(Locale.US, "%.6f", loc.getLatitude())
                + ",\"lon\":" + String.format(Locale.US, "%.6f", loc.getLongitude())
                + ",\"acc_m\":" + acc
                + ",\"provider\":\"" + (stale ? "last_known" : safeProviderName(loc)) + "\""
                + ",\"age_s\":" + ageS
                + "}";
        writeJson(json);
    }

    private String safeProviderName(Location loc) {
        String p = loc.getProvider();
        return p == null ? "unknown" : p;
    }

    private void writeError(String code) {
        writeJson("{\"error\":\"" + code + "\",\"ts\":" + System.currentTimeMillis() + "}");
    }

    private void writeJson(String json) {
        try {
            File dir = getExternalFilesDir(null);
            if (dir == null) return;
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, "location.json");
            File tmp = new File(dir, "location.json.tmp");
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

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
