import com.couplechat.app.AssetServer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 桌面上的 AssetServer 验证器：用文件目录当 Source，跑与手机上完全同一份 HTTP 服务代码。
 *
 * 目的：手机外壳里唯一"自己写的东西"就是这段服务 + WebView 装配；WebView 装不了就只能上真机，
 * 但 HTTP 这一层可以在这里被真跑一遍（桌面 JDK，不依赖 android.jar）。
 *
 * 用法：
 *   javac -d ../build/harness-classes src/com/couplechat/app/AssetServer.java harness/ServerHarness.java
 *   java -cp ../build/harness-classes ServerHarness <www目录> <端口>
 * 然后 curl http://127.0.0.1:<端口>/ 看返回。
 */
public final class ServerHarness {

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("用法: ServerHarness <www目录> <端口>");
            System.exit(2);
        }
        final File root = new File(args[0]);
        int port = Integer.parseInt(args[1]);

        AssetServer.Source source = new AssetServer.Source() {
            @Override
            public byte[] read(String path) throws IOException {
                String rel = path.startsWith("/") ? path.substring(1) : path;
                File f = new File(root, rel);
                if (!f.isFile()) throw new IOException("not a file: " + f);
                InputStream is = new FileInputStream(f);
                try {
                    ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(1024, f.length()));
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
                    return out.toByteArray();
                } finally {
                    is.close();
                }
            }
        };

        AssetServer server = new AssetServer(source, port);
        int actual = server.start();
        System.out.println("HARNESS-READY port=" + actual + " root=" + root.getAbsolutePath());
        System.out.flush();
        // 跑 60 秒供外部探测，然后自己退出
        Thread.sleep(60000L);
        server.stop();
        System.out.println("HARNESS-STOPPED");
    }
}
