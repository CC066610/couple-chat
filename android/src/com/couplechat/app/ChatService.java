package com.couplechat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

/**
 * 前台服务：把「直连」钉在后台，直到用户自己关掉。
 *
 * v1.8：按用户要求把保活做到系统允许的极限（电量不是约束）：
 *   · 唤醒锁不再设 1 小时上限，改为「常驻 + 每 20 分钟续一次」，防止某些 ROM 静默释放；
 *   · WifiLock 用 WIFI_MODE_FULL_HIGH_PERF（屏幕关掉也不降功耗）；
 *   · onTaskRemoved 时不自杀，让服务继续跑（从最近任务划掉也不会立刻断）；
 *   · 真正决定「能不能一直活」的是电池优化白名单，这里只负责申请，用户在系统弹窗点允许。
 *
 * 平台边界（诚实，别指望绕过）：
 *   · Doze 深睡（屏幕关着且静止很久）会掐网络，只有「忽略电池优化」能豁免；
 *   · Android 15 起 dataSync 型前台服务有累计时长上限（约 6 小时/24 小时），到点系统会收走；
 *   · 对方关页面 / 换 Wi-Fi 与 4G 互切，任何保活都救不了（那是链路重建问题，见 v1.7 的自动重连）。
 */
public class ChatService extends Service {

    private static final String TAG = "CoupleChat";
    private static final String CHANNEL = "link";
    private static final int NOTIF_ID = 0x0C0C;
    private static final long RENEW_MS = 20L * 60L * 1000L;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Handler handler;
    private Runnable renew;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());

        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "保持直连", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("让点对点直连在切后台后继续存活");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setContentTitle("两个人的聊天")
         .setContentText("正在保持直连 · 切后台也不会断（关掉本通知才允许系统挂起）")
         .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
         .setOngoing(true)
         .setShowWhen(false);

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, b.build());
        }

        acquireLocks();
        renew = new Runnable() {
            @Override
            public void run() {
                acquireLocks();                     // 续锁：某些 ROM 会静默释放
                handler.postDelayed(this, RENEW_MS);
            }
        };
        handler.postDelayed(renew, RENEW_MS);
        Log.i(TAG, "keep-alive started (no timeout wake lock)");
    }

    private void acquireLocks() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null && (wakeLock == null || !wakeLock.isHeld())) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "couplechat:link");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();                      // 不设超时：用户说电量不是约束
            Log.i(TAG, "wakelock acquired (indefinite)");
        }
        if (wifiLock == null || !wifiLock.isHeld()) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "couplechat:wifi");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;                         // 被系统杀掉就尽量拉回来
    }

    /** 从最近任务里划掉时：不结束服务，连接继续。 */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "task removed, keeping service alive");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (handler != null && renew != null) handler.removeCallbacks(renew);
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        Log.i(TAG, "keep-alive stopped");
        super.onDestroy();
    }
}
