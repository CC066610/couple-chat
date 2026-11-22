#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
两个人的聊天 · 安卓 APK 构建脚本（不依赖 Gradle / Android Studio）

流水线：
  assets/www  <- app/ 前端资源
  javac       -> build/classes        （-source 11 -target 11，d8 只吃得到 Java 11 字节码）
  d8          -> build/dex/classes.dex
  aapt2 compile/link -> build/base.apk（含 res 与 assets）
  塞入 classes.dex -> build/unsigned.apk
  zipalign    -> build/aligned.apk
  apksigner   -> dist/CoupleChat-<ver>.apk

依赖（一次性）：
  D:\\dsh\\_ca\\android\\build-tools_r34.zip  -> build-tools/android-14/{aapt2,zipalign,apksigner,d8}
  D:\\dsh\\_ca\\android\\platform-34.zip      -> platform/android-14/android.jar
JDK：任何 11+ 的 javac / keytool（本机 D:\\jdk\\jdk-21.0.4）。

用法： python android/build.py [--version 1.0]
"""

import argparse
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # couple-chat/
APP = os.path.join(ROOT, 'app')
SDK_SRC = r'D:\dsh\_ca\android'
SDK = os.path.join(HERE, '.sdk')
BT = os.path.join(SDK, 'build-tools', 'android-14')
PLATFORM = os.path.join(SDK, 'platform', 'android-34', 'android.jar')
JAVA_HOME = r'D:\jdk\jdk-21.0.4'
JAVAC = os.path.join(JAVA_HOME, 'bin', 'javac.exe')
KEYTOOL = os.path.join(JAVA_HOME, 'bin', 'keytool.exe')
BUILD = os.path.join(HERE, 'build')
DIST = os.path.join(HERE, 'dist')
MIN_SDK = '21'
TARGET_SDK = '34'


def run(cmd, **kw):
    printable = cmd if isinstance(cmd, str) else ' '.join(cmd)
    print('>>', printable)
    r = subprocess.run(cmd, shell=isinstance(cmd, str), **kw)
    if r.returncode != 0:
        sys.exit('命令失败（exit %d）：%s' % (r.returncode, printable))
    return r


def ensure_sdk():
    if os.path.isfile(os.path.join(BT, 'aapt2.exe')) and os.path.isfile(PLATFORM):
        return
    os.makedirs(SDK, exist_ok=True)
    for src, dest_dir, marker in (
        (os.path.join(SDK_SRC, 'build-tools_r34.zip'), os.path.join(SDK, 'build-tools'), 'android-14/aapt2.exe'),
        (os.path.join(SDK_SRC, 'platform-34.zip'), os.path.join(SDK, 'platform'), 'android-34/android.jar'),
    ):
        if not os.path.isfile(src):
            sys.exit('缺少 %s —— 先按 README 里的两条 curl 下载' % src)
        with zipfile.ZipFile(src) as z:
            if marker not in z.namelist():
                sys.exit('%s 里没有 %s，包可能下错了' % (src, marker))
            z.extractall(dest_dir)
    if not os.path.isfile(PLATFORM):
        sys.exit('解包后仍找不到 android.jar')


def stage_assets():
    www = os.path.join(HERE, 'assets', 'www')
    if os.path.isdir(www):
        shutil.rmtree(www)
    os.makedirs(www)
    for dirpath, dirnames, filenames in os.walk(APP):
        dirnames[:] = [d for d in dirnames if d != 'dev']    # app/dev 是自测码落地目录，不进安装包
        for name in filenames:
            if name.endswith(('.map', '.log')) or name in ('Thumbs.db', '.DS_Store'):
                continue
            src = os.path.join(dirpath, name)
            rel = os.path.relpath(src, APP)
            dst = os.path.join(www, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    total = 0
    count = 0
    for dirpath, _d, filenames in os.walk(www):
        for name in filenames:
            total += os.path.getsize(os.path.join(dirpath, name))
            count += 1
    print('  资源：%d 个文件，%.1f KB' % (count, total / 1024.0))


def build(version, version_code=None):
    ensure_sdk()
    if os.path.isdir(BUILD):
        shutil.rmtree(BUILD)
    for d in ('classes', 'dex', 'gen'):
        os.makedirs(os.path.join(BUILD, d))

    print('== 1/6 暂存前端资源 ==')
    stage_assets()

    print('== 2/6 javac ==')
    sources = []
    for dirpath, _d, filenames in os.walk(os.path.join(HERE, 'src')):
        for name in filenames:
            if name.endswith('.java'):
                sources.append(os.path.join(dirpath, name))
    run([JAVAC, '-encoding', 'UTF-8', '--release', '8',
         '-classpath', PLATFORM, '-d', os.path.join(BUILD, 'classes')] + sources)

    print('== 3/6 d8 -> classes.dex ==')
    classes = []
    for dirpath, _d, filenames in os.walk(os.path.join(BUILD, 'classes')):
        for name in filenames:
            if name.endswith('.class'):
                classes.append(os.path.join(dirpath, name))
    dexdir = os.path.join(BUILD, 'dex')
    # build-tools 34 自带的 R8 8.2.2 在 JDK 21 上会 NPE（R8 内部 String.length() NPE），
    # 所以优先用官方 maven 独立发布的 r8.jar（同一个 D8，只是版本更新）。
    r8_jar = os.path.join(SDK_SRC, 'r8-8.11.18.jar')
    class_args = ' '.join('"%s"' % c for c in classes)
    if os.path.isfile(r8_jar):
        run('"%s" -cp "%s" com.android.tools.r8.D8 --release --min-api %s --lib "%s" --output "%s" %s' % (
            os.path.join(JAVA_HOME, 'bin', 'java.exe'), r8_jar, MIN_SDK, PLATFORM, dexdir, class_args))
    else:
        run('"%s" --release --min-api %s --lib "%s" --output "%s" %s' % (
            os.path.join(BT, 'd8.bat'), MIN_SDK, PLATFORM, dexdir, class_args))

    print('== 4/6 aapt2 compile + link ==')
    run('"%s" compile --dir "%s" -o "%s"' % (
        os.path.join(BT, 'aapt2.exe'), os.path.join(HERE, 'res'), os.path.join(BUILD, 'res.zip')))
    run('"%s" link -o "%s" -I "%s" --manifest "%s" -R "%s" -A "%s" '
        '--min-sdk-version %s --target-sdk-version %s --version-code %s --version-name %s --auto-add-overlay' % (
            os.path.join(BT, 'aapt2.exe'), os.path.join(BUILD, 'base.apk'), PLATFORM,
            os.path.join(HERE, 'AndroidManifest.xml'), os.path.join(BUILD, 'res.zip'),
            os.path.join(HERE, 'assets'), MIN_SDK, TARGET_SDK, version_code, version))

    print('== 5/6 塞入 classes.dex ==')
    unsigned = os.path.join(BUILD, 'unsigned.apk')
    shutil.copy2(os.path.join(BUILD, 'base.apk'), unsigned)
    with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(BUILD, 'dex', 'classes.dex'), 'classes.dex')

    print('== 6/6 zipalign + apksigner ==')
    aligned = os.path.join(BUILD, 'aligned.apk')
    run('"%s" -p -f 4 "%s" "%s"' % (os.path.join(BT, 'zipalign.exe'), unsigned, aligned))

    ks = os.path.join(HERE, 'couplechat-release.keystore')
    if not os.path.isfile(ks):
        print('  生成签名密钥（有效期 30 年，请自己留好，升级要用同一把）')
        run('"%s" -genkeypair -keystore "%s" -alias couplechat -keyalg RSA -keysize 2048 '
            '-validity 10950 -storepass couplechat -keypass couplechat '
            '-dname "CN=CoupleChat, OU=CoupleChat, O=CoupleChat, L=Local, C=CN"' % (KEYTOOL, ks))

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, 'CoupleChat-%s.apk' % version)
    if os.path.isfile(out):
        os.remove(out)
    run('"%s" sign --ks "%s" --ks-key-alias couplechat --ks-pass pass:couplechat '
        '--key-pass pass:couplechat --v1-signing-enabled true --v2-signing-enabled true '
        '--min-sdk-version %s --out "%s" "%s"' % (
            os.path.join(BT, 'apksigner.bat'), ks, MIN_SDK, out, aligned))

    run('"%s" verify --print-certs "%s"' % (os.path.join(BT, 'apksigner.bat'), out))
    run('"%s" dump badging "%s"' % (os.path.join(BT, 'aapt2.exe'), out), stdout=subprocess.DEVNULL)

    size = os.path.getsize(out)
    print('\nBUILT %s  (%.1f KB)' % (out, size / 1024.0))
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', default='1.0')
    ap.add_argument('--version-code', type=int, default=None,
                    help='安卓 versionCode（升级必须递增；默认按 主*100+次 推算）')
    a = ap.parse_args()
    code = a.version_code
    if code is None:
        parts = [int(x) for x in a.version.split('.')[:2] if x.isdigit()]
        code = (parts[0] * 100 + (parts[1] if len(parts) > 1 else 0)) if parts else 1
    build(a.version, code)
