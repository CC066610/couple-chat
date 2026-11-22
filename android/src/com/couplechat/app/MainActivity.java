package com.couplechat.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import android.webkit.WebViewClient;
import android.provider.Settings;
import android.os.PowerManager;
import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 两个人的聊天 · 手机端外壳。
 *
 * 页面必须跑在「安全上下文」里摄像头才可用（扫码配对）。
 * Android 上只有 http://127.0.0.1 算安全上下文，file:// 和局域网 http:// 都不算，
 * 所以在进程内起一个只听 127.0.0.1 的迷你服务（{@link AssetServer}）把 assets/www 喂给 WebView。
 * 结果：origin 是 http://127.0.0.1:端口 —— 摄像头可用、IndexedDB 可用、聊天记录只落本机。
 *
 * v1.6 起补三处 Android 专属缺口（浏览器里不需要、WebView 里必需）：
 *   1. onShowFileChooser —— 没有它，页面里的 <input type="file"> 点了毫无反应（选不到相册）；
 *   2. RECORD_AUDIO 运行时申请 + RESOURCE_AUDIO_CAPTURE 放行 —— 不然语音消息录不了；
 *   3. onPause/onResume 透给 WebView —— 不加的话切后台再回来，页面里的计时器/连接状态会乱。
 */
public class MainActivity extends Activity {

    private static final String TAG = "CoupleChat";
    private static final int START_PORT = 17321;
    private static final int PORT_TRIES = 12;
    private static final int REQ_PERMS = 1001;
    private static final int REQ_FILE = 1002;

    private WebView web;
    private AssetServer server;
    /** 页面在等文件选择结果；WebView 要求我们自己把结果交回这个回调。 */
    private ValueCallback<Uri[]> filePathCallback;
    private boolean keepAliveWanted = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 页面（127.0.0.1 安全上下文）申请摄像头/麦克风时放行
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 没有这个方法，「＋」按钮点了什么都不会发生（就是"选不到相册"的原因）
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent;
                try {
                    intent = params.createIntent();
                } catch (Exception e) {
                    Log.w(TAG, "createIntent failed: " + e);
                    filePathCallback = null;
                    return false;
                }
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择要发送的图片 / 视频 / 文件"), REQ_FILE);
                } catch (Exception e) {
                    Log.w(TAG, "no activity for file chooser: " + e);
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new NativeBridge(), "Native");
        web.setBackgroundColor(0xFF0F1115);

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        askPermissions();
        startServerAndLoad();
        startLinkService();
    }

    private void askPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        java.util.ArrayList<String> want = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.CAMERA);
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            want.add("android.permission.POST_NOTIFICATIONS");   // 前台服务的常驻通知要靠它显示
        }
        if (!want.isEmpty()) {
            requestPermissions(want.toArray(new String[0]), REQ_PERMS);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (filePathCallback == null) return;

        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) {
                    result[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    private void startServerAndLoad() {
        if (server != null) return;
        final android.content.res.AssetManager assets = getAssets();
        AssetServer.Source source = new AssetServer.Source() {
            @Override
            public byte[] read(String path) throws IOException {
                InputStream is = assets.open("www" + path);
                try {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, is.available()));
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
                    return out.toByteArray();
                } finally {
                    try { is.close(); } catch (IOException ignored) {}
                }
            }
        };

        for (int i = 0; i < PORT_TRIES; i++) {
            int candidate = START_PORT + i;
            AssetServer probe = new AssetServer(source, candidate);
            try {
                probe.start();
                server = probe;
                break;
            } catch (IOException e) {
                Log.w(TAG, "port " + candidate + " unavailable: " + e.getMessage());
            }
        }

        if (server == null) {
            web.loadData("<h3 style='color:#eee;background:#111;font-family:sans-serif;padding:24px'>"
                            + "端口都被占用了，无法启动。关掉其他实例再试。</h3>",
                    "text/html; charset=utf-8", "utf-8");
            return;
        }
        String url = "http://127.0.0.1:" + server.port() + "/";
        Log.i(TAG, "serving " + url);
        web.loadUrl(url);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        // 不调 web.onPause()：它会把 JS 定时器一起冻住，页面的心跳/已读水位就停了。
        // 进程本身由 ChatService（前台服务 + 唤醒锁）保着，这里只需要让 WebView 继续跑。
        if (web != null) web.resumeTimers();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    /** 页面可调的原生能力：保活开关、电池白名单、状态查询。 */
    private class NativeBridge {
        @JavascriptInterface
        public String status() {
            boolean svc = keepAliveWanted;
            boolean ignoring = isIgnoringBattery();
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            boolean doze = (pm != null && Build.VERSION.SDK_INT >= 23 && pm.isDeviceIdleMode());
            return "{\"service\":" + svc + ",\"ignoringBattery\":" + ignoring + ",\"doze\":" + doze + "}";
        }

        @JavascriptInterface
        public void keepAlive(boolean on) {
            keepAliveWanted = on;
            if (on) startLinkService(); else stopService(new Intent(MainActivity.this, ChatService.class));
        }

        /** 直接弹系统的"忽略电池优化"授权框（比引导用户翻五层菜单省事）。 */
        @JavascriptInterface
        public boolean requestBatteryExemption() {
            if (isIgnoringBattery()) return true;
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName()));
                startActivity(i);
                return true;
            } catch (Exception e) {
                try {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    return true;
                } catch (Exception e2) {
                    Log.w(TAG, "cannot open battery settings: " + e2);
                    return false;
                }
            }
        }
    }

    private boolean isIgnoringBattery() {
        if (Build.VERSION.SDK_INT < 23) return true;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    /** 起前台服务：把本进程从 cached 桶里抬出来，切后台/息屏时直连才不至于立刻断。 */
    private void startLinkService() {
        Intent svc = new Intent(this, ChatService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
            else startService(svc);
        } catch (Exception e) {
            Log.w(TAG, "cannot start ChatService: " + e);
        }
    }

    @Override
    protected void onDestroy() {
        try { stopService(new Intent(this, ChatService.class)); } catch (Exception ignored) {}

        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
