"""把两个平台的构建产物装成可直接发给别人下载的压缩包。

用法：
    python desktop/build.py --version 1.3
    python android/build.py --version 1.3
    python pack.py --version 1.3

产物：
    desktop/dist/CoupleChat-<ver>-windows-x64.zip
    android/dist/CoupleChat-<ver>-android.zip
每个压缩包里都是一个同名文件夹：可执行文件 + 中文说明 + SHA256.txt。
"""

import argparse
import hashlib
import os
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def write_sha_file(folder, names):
    lines = ['%s  %s' % (sha256(os.path.join(folder, n)), n) for n in names]
    path = os.path.join(folder, 'SHA256.txt')
    with open(path, 'w', encoding='utf-8-sig', newline='\r\n') as f:
        f.write('\n'.join(lines) + '\n')
    return path


def zip_folder(folder, out_path):
    if os.path.exists(out_path):
        os.remove(out_path)
    base = os.path.basename(folder)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(folder)):
            full = os.path.join(folder, name)
            if os.path.isfile(full):
                z.write(full, base + '/' + name)
    return out_path


def pack_desktop(version):
    dist = os.path.join(HERE, 'desktop', 'dist')
    exe = os.path.join(dist, 'CoupleChat.exe')
    if not os.path.exists(exe):
        sys.exit('找不到 %s，先跑 python desktop/build.py --version %s' % (exe, version))
    folder = os.path.join(dist, 'CoupleChat-%s-windows-x64' % version)
    if os.path.isdir(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    shutil.copy2(exe, os.path.join(folder, 'CoupleChat.exe'))
    shutil.copy2(os.path.join(HERE, 'desktop', '使用说明.txt'),
                 os.path.join(folder, '使用说明.txt'))
    write_sha_file(folder, ['CoupleChat.exe', '使用说明.txt'])
    out = zip_folder(folder, os.path.join(dist, 'CoupleChat-%s-windows-x64.zip' % version))
    return out


def pack_android(version):
    dist = os.path.join(HERE, 'android', 'dist')
    apk = os.path.join(dist, 'CoupleChat-%s.apk' % version)
    if not os.path.exists(apk):
        sys.exit('找不到 %s，先跑 python android/build.py --version %s' % (apk, version))
    folder = os.path.join(dist, 'CoupleChat-%s-android' % version)
    if os.path.isdir(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    apk_name = 'CoupleChat-%s.apk' % version
    shutil.copy2(apk, os.path.join(folder, apk_name))
    shutil.copy2(os.path.join(HERE, 'android', '安装说明.txt'),
                 os.path.join(folder, '安装说明.txt'))
    write_sha_file(folder, [apk_name, '安装说明.txt'])
    out = zip_folder(folder, os.path.join(dist, 'CoupleChat-%s-android.zip' % version))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', default='1.3')
    ap.add_argument('--only', choices=['desktop', 'android'], default=None)
    a = ap.parse_args()

    made = []
    if a.only != 'android':
        made.append(pack_desktop(a.version))
    if a.only != 'desktop':
        made.append(pack_android(a.version))

    for path in made:
        print('%s  %.1f KB  sha256=%s' % (path, os.path.getsize(path) / 1024.0, sha256(path)))


if __name__ == '__main__':
    main()
