"""把 app/ 目录打成一个 C# 资源类，再用系统自带的 csc.exe 编成单文件 exe。

用法：python build.py        （在 desktop/ 目录里跑，或从别处跑都行）
产物：desktop/dist/CoupleChat.exe
"""
import base64
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, '..', 'app'))
DIST = os.path.join(HERE, 'dist')
ASSETS_CS = os.path.join(HERE, 'Assets.cs')

SKIP_EXT = {'.map', '.log', '.tmp'}
SKIP_NAME = {'Thumbs.db', '.DS_Store'}
SKIP_DIR = {'dev'}          # app/dev 是自测码落地目录，不该进二进制


def collect():
    files = []
    for root, dirs, names in os.walk(APP):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIR)
        for name in sorted(names):
            if name in SKIP_NAME:
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext in SKIP_EXT:
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, APP).replace(os.sep, '/')
            files.append((rel, full))
    return files


def write_assets(files):
    out = io.StringIO()
    out.write('// 自动生成，不要手改。由 desktop/build.py 从 app/ 目录生成。\n')
    out.write('using System;\nusing System.Collections.Generic;\n\n')
    out.write('namespace CoupleChat\n{\n')
    out.write('    static class Assets\n    {\n')
    out.write('        public static readonly Dictionary<string, byte[]> Files =\n')
    out.write('            new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase)\n        {\n')
    for rel, full in files:
        with open(full, 'rb') as f:
            data = f.read()
        b64 = base64.b64encode(data).decode('ascii')
        chunks = [b64[i:i + 120] for i in range(0, len(b64), 120)]
        out.write('            { "%s", Convert.FromBase64String(\n' % rel)
        for i, chunk in enumerate(chunks):
            arrow = ' +' if i < len(chunks) - 1 else ''
            out.write('                "%s"%s\n' % (chunk, arrow))
        out.write('            ) },\n')
    out.write('        };\n')
    out.write('    }\n}\n')
    with open(ASSETS_CS, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(out.getvalue())
    return sum(len(open(full, 'rb').read()) for _, full in files)


def ensure_bom(path):
    """csc 只有在源码带 BOM 时才按 UTF-8 解析，否则中文串会变乱码。"""
    with open(path, 'rb') as f:
        data = f.read()
    if data.startswith(b'\xef\xbb\xbf'):
        return False
    with open(path, 'wb') as f:
        f.write(b'\xef\xbb\xbf' + data)
    return True


def find_csc():
    roots = [
        os.path.expandvars(r'%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        os.path.expandvars(r'%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe'),
    ]
    for r in roots:
        if os.path.isfile(r):
            return r
    return None


def main():
    if not os.path.isdir(APP):
        print('找不到前端目录：%s' % APP)
        return 1
    files = collect()
    total = write_assets(files)
    print('资源：%d 个文件，共 %.1f KB → Assets.cs' % (len(files), total / 1024.0))

    for name in ('Program.cs', 'Assets.cs'):
        if ensure_bom(os.path.join(HERE, name)):
            print('  补 BOM：%s' % name)

    csc = find_csc()
    if not csc:
        print('找不到 csc.exe（需要 .NET Framework 4.x，Windows 自带）')
        return 2

    os.makedirs(DIST, exist_ok=True)
    exe = os.path.join(DIST, 'CoupleChat.exe')
    cmd = [
        csc, '/nologo', '/target:exe', '/platform:anycpu', '/optimize+',
        '/utf8output', '/out:' + exe,
        os.path.join(HERE, 'Program.cs'), os.path.join(HERE, 'Assets.cs'),
    ]
    print('编译：' + os.path.basename(csc))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    if proc.returncode != 0 or not os.path.isfile(exe):
        print('编译失败（exit %d）' % proc.returncode)
        return 3
    print('BUILT %s  (%.1f KB)' % (exe, os.path.getsize(exe) / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
