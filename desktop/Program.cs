// CoupleChat — 两个人的聊天（单文件本地服务）
// 把所有前端资源嵌进本 exe，起一个只在局域网/本机可见的小 HTTP 服务，然后打开默认浏览器。
// 依赖：仅 .NET Framework（Windows 自带），不需要 Node / Python / Electron。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace CoupleChat
{
    static class Program
    {
        static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" },
            { ".css",  "text/css; charset=utf-8" },
            { ".js",   "text/javascript; charset=utf-8" },
            { ".mjs",  "text/javascript; charset=utf-8" },
            { ".json", "application/json; charset=utf-8" },
            { ".svg",  "image/svg+xml" },
            { ".png",  "image/png" },
            { ".ico",  "image/x-icon" },
            { ".txt",  "text/plain; charset=utf-8" },
            { ".md",   "text/markdown; charset=utf-8" },
        };

        static int Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }

            int port = 8123;
            bool autoOpen = true;
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--port":
                        if (i + 1 < args.Length) { int p; if (int.TryParse(args[i + 1], out p) && p > 0 && p < 65536) port = p; i++; }
                        break;
                    case "--no-open": autoOpen = false; break;
                    case "--help":
                    case "-h": Usage(); return 0;
                }
            }

            TcpListener listener = null;
            for (int attempt = 0; attempt < 10 && listener == null; attempt++)
            {
                try
                {
                    listener = new TcpListener(IPAddress.Any, port);
                    listener.Start();
                }
                catch (SocketException e)
                {
                    listener = null;
                    port++;
                    if (attempt == 9)
                    {
                        Console.WriteLine("起不来：端口一直被占用。" + e.Message);
                        return 2;
                    }
                }
            }

            string local = "http://127.0.0.1:" + port + "/";
            Console.WriteLine("CoupleChat 1.8  ·  两个人的聊天（电脑版）");
            Console.WriteLine("纯本地运行：没有服务器、没有账号，聊天记录只保存在你自己的浏览器里。");
            Console.WriteLine();
            Console.WriteLine("  本机打开             " + local);
            List<string> ips = LanIps();
            foreach (string ip in ips)
                Console.WriteLine("  让对方在局域网打开   http://" + ip + ":" + port + "/");
            if (ips.Count == 0)
                Console.WriteLine("  （没有检测到局域网地址：两台设备请在同一 Wi-Fi / 同一网段）");
            Console.WriteLine();
            Console.WriteLine("注意：手机或另一台电脑通过局域网 http:// 打开时，浏览器不允许调用摄像头");
            Console.WriteLine("      （只在 localhost 与 https 下放开）。这种情况请用页面里的「粘贴对方的码」。");
            Console.WriteLine();
            Console.WriteLine("关闭这个窗口或按 Ctrl+C 即退出。");
            Console.WriteLine();

            if (autoOpen) TryOpen(local);

            ThreadPool.SetMinThreads(8, 8);
            while (true)
            {
                TcpClient client = listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(delegate { Serve(client); });
            }
        }

        static void Usage()
        {
            Console.WriteLine("CoupleChat.exe [--port 8123] [--no-open]");
            Console.WriteLine();
            Console.WriteLine("  --port N     指定端口（默认 8123，被占用时自动往后找）");
            Console.WriteLine("  --no-open    不自动打开浏览器");
            Console.WriteLine("  --help       显示这段帮助");
        }

        static List<string> LanIps()
        {
            List<string> result = new List<string>();
            try
            {
                IPAddress[] addresses = Dns.GetHostAddresses(Dns.GetHostName());
                foreach (IPAddress a in addresses)
                {
                    if (a.AddressFamily != AddressFamily.InterNetwork) continue;
                    if (IPAddress.IsLoopback(a)) continue;
                    string s = a.ToString();
                    if (s.StartsWith("169.254.")) continue;   // 自动私有地址，基本不可用
                    result.Add(s);
                }
            }
            catch { }
            return result;
        }

        static void TryOpen(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception e) { Console.WriteLine("（自动打开浏览器失败：" + e.Message + "，请手动复制上面的地址）"); }
        }

        static void Serve(object state)
        {
            TcpClient client = (TcpClient)state;
            try
            {
                client.NoDelay = true;
                using (NetworkStream stream = client.GetStream())
                {
                    stream.ReadTimeout = 5000;
                    stream.WriteTimeout = 5000;

                    string head = ReadHead(stream);
                    if (head == null) return;

                    string path = RequestPath(head);
                    if (path == null) return;
                    if (path == "/favicon.ico") { WriteEmpty(stream, "204 No Content"); return; }

                    string name = path == "/" ? "index.html" : path.Substring(1);
                    name = Uri.UnescapeDataString(name).Replace('\\', '/');
                    if (name.Contains("..")) { WriteEmpty(stream, "403 Forbidden"); return; }

                    byte[] body;
                    if (!Assets.Files.TryGetValue(name, out body))
                    {
                        WriteEmpty(stream, "404 Not Found");
                        return;
                    }

                    string ext = Path.GetExtension(name);
                    string type;
                    if (!Mime.TryGetValue(ext, out type)) type = "application/octet-stream";

                    StringBuilder header = new StringBuilder();
                    header.Append("HTTP/1.1 200 OK\r\n");
                    header.Append("Content-Type: ").Append(type).Append("\r\n");
                    header.Append("Content-Length: ").Append(body.Length).Append("\r\n");
                    header.Append("Cache-Control: no-store\r\n");
                    header.Append("X-Content-Type-Options: nosniff\r\n");
                    header.Append("Connection: close\r\n\r\n");

                    byte[] headerBytes = Encoding.ASCII.GetBytes(header.ToString());
                    stream.Write(headerBytes, 0, headerBytes.Length);
                    stream.Write(body, 0, body.Length);
                    stream.Flush();
                }
            }
            catch { /* 浏览器提前断开很常见，静默 */ }
            finally
            {
                try { client.Close(); } catch { }
            }
        }

        static string ReadHead(NetworkStream stream)
        {
            MemoryStream buffer = new MemoryStream();
            byte[] one = new byte[1];
            int read;
            while ((read = stream.Read(one, 0, 1)) == 1)
            {
                buffer.WriteByte(one[0]);
                if (buffer.Length >= 16384) break;
                if (buffer.Length >= 4)
                {
                    byte[] b = buffer.GetBuffer();
                    int n = (int)buffer.Length;
                    if (b[n - 4] == 13 && b[n - 3] == 10 && b[n - 2] == 13 && b[n - 1] == 10)
                        return Encoding.ASCII.GetString(b, 0, n);
                }
            }
            return buffer.Length > 0 ? Encoding.ASCII.GetString(buffer.GetBuffer(), 0, (int)buffer.Length) : null;
        }

        static string RequestPath(string head)
        {
            string[] lines = head.Split('\n');
            if (lines.Length == 0) return null;
            string[] parts = lines[0].Trim().Split(' ');
            if (parts.Length < 2) return null;
            if (parts[0] != "GET" && parts[0] != "HEAD") return null;
            string target = parts[1];
            int q = target.IndexOf('?');
            if (q >= 0) target = target.Substring(0, q);
            if (!target.StartsWith("/")) target = "/" + target;
            return target;
        }

        static void WriteEmpty(NetworkStream stream, string status)
        {
            byte[] bytes = Encoding.ASCII.GetBytes(
                "HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }
    }
}
