package com.couplechat.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

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
 */
public class MainActivity extends Activity {

    private static final String TAG = "CoupleChat";
    private static final int START_PORT = 17321;
    private static final int PORT_TRIES = 12;
    private static final int REQ_CAMERA = 1001;

    private WebView web;
    private AssetServer server;

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
                // 页面（127.0.0.1 安全上下文）申请摄像头时放行
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }
        });
        web.setBackgroundColor(0xFF0F1115);

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
        startServerAndLoad();
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
    protected void onDestroy() {
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
