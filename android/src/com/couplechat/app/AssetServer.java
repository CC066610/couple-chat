package com.couplechat.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 只听 127.0.0.1 的极简静态 HTTP 服务（GET/HEAD）。
 *
 * 刻意不依赖 android.*：内容由 {@link Source} 提供，
 * 于是同一份代码既能在手机上喂 assets/www，也能在桌面用文件目录跑测试
 * （见 android/harness/ServerHarness.java）。
 *
 * 为什么需要它：WebView 里页面必须处于「安全上下文」，摄像头（扫码）才可用；
 * 只有 http://127.0.0.1 在 Android 上被当作安全上下文，file:// 与局域网 http:// 都不是。
 */
public final class AssetServer implements Runnable {

    /** 内容来源：传入以 "/" 开头的路径，返回字节；找不到就抛 IOException。 */
    public interface Source {
        byte[] read(String path) throws IOException;
    }

    private static final Map<String, String> TYPES = new HashMap<String, String>();

    static {
        TYPES.put("html", "text/html; charset=utf-8");
        TYPES.put("css", "text/css; charset=utf-8");
        TYPES.put("js", "text/javascript; charset=utf-8");
        TYPES.put("mjs", "text/javascript; charset=utf-8");
        TYPES.put("json", "application/json; charset=utf-8");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("txt", "text/plain; charset=utf-8");
        TYPES.put("woff2", "font/woff2");
    }

    private final Source source;
    private final int wantPort;
    private ServerSocket socket;
    private volatile boolean running = true;
    private Thread thread;

    public AssetServer(Source source, int wantPort) {
        this.source = source;
        this.wantPort = wantPort;
    }

    /** 绑定并开始接受连接；返回实际端口。抛 IOException 表示端口不可用。 */
    public int start() throws IOException {
        socket = new ServerSocket(wantPort, 16, InetAddress.getByName("127.0.0.1"));
        thread = new Thread(this, "asset-http");
        thread.setDaemon(true);
        thread.start();
        return socket.getLocalPort();
    }

    public int port() {
        return socket == null ? -1 : socket.getLocalPort();
    }

    public void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
    }

    @Override
    public void run() {
        while (running) {
            Socket c = null;
            try {
                c = socket.accept();
                handle(c);
            } catch (IOException e) {
                if (running) {
                    // 单个连接出错不影响服务
                }
            } finally {
                if (c != null) {
                    try { c.close(); } catch (IOException ignored) {}
                }
            }
        }
    }

    private void handle(Socket c) throws IOException {
        InputStream in = c.getInputStream();
        String requestLine = readLine(in);
        if (requestLine == null) return;
        String line;
        int guard = 0;
        while ((line = readLine(in)) != null && !line.isEmpty() && guard++ < 100) {
            // 丢弃请求头
        }

        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return;
        boolean headOnly = "HEAD".equalsIgnoreCase(parts[0]);
        String target = parts[1];
        int q = target.indexOf('?');
        if (q >= 0) target = target.substring(0, q);
        String path = java.net.URLDecoder.decode(target, "UTF-8");
        if (path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..")) {
            write(c, "400 Bad Request", "text/plain; charset=utf-8",
                    "bad path".getBytes("UTF-8"), false);
            return;
        }

        byte[] body;
        try {
            body = source.read(path);
        } catch (IOException e) {
            write(c, "404 Not Found", "text/plain; charset=utf-8",
                    ("not found: " + path).getBytes("UTF-8"), false);
            return;
        }

        int dot = path.lastIndexOf('.');
        String type = "application/octet-stream";
        if (dot >= 0) {
            String ext = path.substring(dot + 1).toLowerCase(Locale.ROOT);
            if (TYPES.containsKey(ext)) type = TYPES.get(ext);
        }
        write(c, "200 OK", type, body, headOnly);
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int ch;
        while ((ch = in.read()) != -1) {
            if (ch == '\n') {
                int len = sb.length();
                if (len > 0 && sb.charAt(len - 1) == '\r') sb.setLength(len - 1);
                return sb.toString();
            }
            sb.append((char) ch);
            if (sb.length() > 8192) break;
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    private static void write(Socket c, String status, String type, byte[] body, boolean headOnly)
            throws IOException {
        OutputStream out = c.getOutputStream();
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("X-Content-Type-Options: nosniff\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        if (!headOnly) out.write(body);
        out.flush();
    }
}
