#!/usr/bin/env python3
"""安卓签名密钥的加密备份 / 恢复工具（不依赖 7z、openssl、gpg）。

容器格式（.ccks，全部字段均为大端定长）：

    magic      6 B   b"CCKS1\\n"
    version    1 B   0x01
    salt      16 B   scrypt 盐
    nonce     12 B   AES-GCM nonce
    body       N B   AES-256-GCM 密文（明文是 zip 字节）
    tag       16 B   GCM 认证标签

KDF：scrypt(N=2^15, r=8, p=1, dkLen=32)。
明文是一个 zip：keystore + README.txt + SHA256.txt，解出来即可直接恢复。

用法：
    # 备份（口令从环境变量读，别写在命令行里——会进 shell 历史）
    export CC_KS_PASS='...'
    python tools/keystore-backup.py backup \
        --keystore android/couplechat-release.keystore \
        --out ../couplechat-backup/couplechat-keystore-20261123.ccks

    # 列出容器内容（不解密到磁盘）
    python tools/keystore-backup.py list --in <file.ccks>

    # 恢复（解出 keystore 并按指纹自检）
    python tools/keystore-backup.py restore --in <file.ccks> --out android/couplechat-release.keystore

    # 只校验（解密到临时目录、比对指纹、不改任何文件）
    python tools/keystore-backup.py verify --in <file.ccks> --expect 5D:05:CE:76:...

退出码：0 成功；2 参数/IO 错误；3 口令错误或容器被改（GCM 认证失败）；4 指纹不符。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import sys
import tempfile
import zipfile

MAGIC = b"CCKS1\n"
VERSION = 1
SALT_LEN = 16
NONCE_LEN = 12
TAG_LEN = 16
KEY_LEN = 32
SCRYPT_N = 2 ** 15
SCRYPT_R = 8
SCRYPT_P = 1

CERT_FPR = "5D:05:CE:76:C2:76:48:22:D4:85:54:17:1D:BE:64:42:E0:12:04:52:A4:DC:74:D4:7C:C8:D5:08:F8:59:69:91"
KEYSTORE_SHA256 = "9bc71b9c11d43ed948ccac19ee4e94554f1c0ddba80301b438bd9db3745217d1"


def _crypto():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    except ImportError:  # pragma: no cover
        sys.exit("需要 python 包 cryptography（pip install cryptography）")
    return AESGCM, Scrypt


def _derive(passphrase: str, salt: bytes) -> bytes:
    _, Scrypt = _crypto()
    return Scrypt(salt=salt, length=KEY_LEN, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P).derive(
        passphrase.encode("utf-8")
    )


def _passphrase(env_name: str) -> str:
    value = os.environ.get(env_name, "")
    if not value:
        sys.exit(f"环境变量 {env_name} 为空；请 export {env_name}='你的口令'")
    if len(value) < 12:
        sys.exit("口令太短：至少 12 个字符（建议 20+）")
    return value


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _readme(keystore_name: str, keystore_bytes: bytes) -> str:
    return f"""两个人的聊天 · 安卓签名密钥备份
================================

这是给 com.couplechat.app 签名的私钥容器，丢了就再也签不出能被已装 App 接受的升级包。

被备份的文件：{keystore_name}
  大小     {len(keystore_bytes)} B
  sha256   {_sha256(keystore_bytes)}
  证书指纹 {CERT_FPR}
  口令     （见你另外保存的那份；默认是 couplechat，写在 android/build.py 里）

恢复：
  1) 解出这个 zip 里的 {keystore_name}
  2) 放回 android/{keystore_name}
  3) 校验指纹（必须与上面一致）：
       keytool -list -v -keystore android/{keystore_name} -storepass <口令> | findstr /i SHA256
  4) python android/build.py --version <ver>
  5) apksigner verify --print-certs android/dist/CoupleChat-<ver>.apk | findstr /i SHA-256

注意：这个容器用 AES-256-GCM 加密，口令错误或文件被改动都会解密失败（不会静默产出坏数据）。
"""


def cmd_backup(args) -> int:
    AESGCM, _ = _crypto()
    src = os.path.abspath(args.keystore)
    if not os.path.isfile(src):
        print(f"找不到 keystore：{src}", file=sys.stderr)
        return 2
    raw = open(src, "rb").read()
    passphrase = _passphrase(args.passphrase_env)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        name = os.path.basename(src)
        z.writestr(name, raw)
        z.writestr("README.txt", _readme(name, raw))
        z.writestr(
            "SHA256.txt",
            f"{_sha256(raw)}  {name}\n{CERT_FPR.replace(':', '').lower()}  certificate-fingerprint\n",
        )
    payload = buf.getvalue()

    salt = os.urandom(SALT_LEN)
    nonce = os.urandom(NONCE_LEN)
    key = _derive(passphrase, salt)
    sealed = AESGCM(key).encrypt(nonce, payload, MAGIC + bytes([VERSION]) + salt)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "wb") as f:
        f.write(MAGIC + bytes([VERSION]) + salt + nonce + sealed)

    size = os.path.getsize(out)
    print(f"[ok] 写了 {out}")
    print(f"     容器 {size} B · 明文 zip {len(payload)} B · keystore {len(raw)} B")
    print(f"     keystore sha256 {_sha256(raw)}")
    print(f"     期望证书指纹   {CERT_FPR}")
    return 0


def _decrypt_container(path: str, passphrase: str) -> bytes:
    AESGCM, _ = _crypto()
    blob = open(path, "rb").read()
    head = len(MAGIC) + 1 + SALT_LEN + NONCE_LEN
    if len(blob) < head + TAG_LEN or not blob.startswith(MAGIC):
        print("不是 .ccks 容器（magic 不符）", file=sys.stderr)
        sys.exit(2)
    version = blob[len(MAGIC)]
    if version != VERSION:
        print(f"容器版本不支持：{version}", file=sys.stderr)
        sys.exit(2)
    p = len(MAGIC) + 1
    salt = blob[p:p + SALT_LEN]
    nonce = blob[p + SALT_LEN:p + SALT_LEN + NONCE_LEN]
    sealed = blob[head:]
    key = _derive(passphrase, salt)
    try:
        return AESGCM(key).decrypt(nonce, sealed, MAGIC + bytes([version]) + salt)
    except Exception:
        print("解密失败：口令不对，或容器被改动过（GCM 认证失败）", file=sys.stderr)
        sys.exit(3)


def _open_payload(payload: bytes) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        print("解密成功但内容不是 zip（容器损坏）", file=sys.stderr)
        sys.exit(2)


def _keystore_entry(zf: zipfile.ZipFile) -> str:
    names = [n for n in zf.namelist() if not n.endswith((".txt", "/")) and n]
    if len(names) != 1:
        print(f"容器里应当正好一个 keystore，实际：{names}", file=sys.stderr)
        sys.exit(2)
    return names[0]


def cmd_list(args) -> int:
    payload = _decrypt_container(args.infile, _passphrase(args.passphrase_env))
    zf = _open_payload(payload)
    print("容器内容：")
    for info in zf.infolist():
        print(f"  {info.filename:<48} {info.file_size:>8} B")
    print("\nREADME.txt 摘要：")
    for line in zf.read("README.txt").decode("utf-8").splitlines()[:8]:
        print("  " + line)
    return 0


def cmd_restore(args) -> int:
    payload = _decrypt_container(args.infile, _passphrase(args.passphrase_env))
    zf = _open_payload(payload)
    name = _keystore_entry(zf)
    data = zf.read(name)
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    if os.path.exists(out) and not args.force:
        print(f"{out} 已存在；确认要覆盖请加 --force（原文件会先备份为 .bak）", file=sys.stderr)
        return 2
    if os.path.exists(out):
        os.replace(out, out + ".bak")
    with open(out, "wb") as f:
        f.write(data)
    print(f"[ok] 恢复 {out}（{len(data)} B，sha256 {_sha256(data)}）")
    if args.expect:
        return _check_fpr(out, args.expect, args.storepass)
    return 0


def _check_fpr(keystore: str, expect: str, storepass: str | None) -> int:
    import subprocess
    java_home = os.environ.get("JAVA_HOME", r"D:\jdk\jdk-21.0.4")
    keytool = os.path.join(java_home, "bin", "keytool.exe")
    if not os.path.isfile(keytool):
        keytool = "keytool"
    cmd = [keytool, "-list", "-v", "-keystore", keystore]
    if storepass:
        cmd += ["-storepass", storepass]
    proc = subprocess.run(cmd, capture_output=True)
    text = (proc.stdout + proc.stderr).decode("utf-8", "replace")
    want = expect.replace(":", "").upper()
    for line in text.splitlines():
        if "SHA256" in line.upper():
            got = line.split(":", 1)[-1].strip().replace(":", "").upper()
            if got == want:
                print(f"[ok] 证书指纹一致：{expect}")
                return 0
            print(f"[!!] 指纹不符：{got}", file=sys.stderr)
            return 4
    print("没能从 keytool 输出里读到 SHA256 指纹（口令是否不对？）", file=sys.stderr)
    return 4


def cmd_verify(args) -> int:
    payload = _decrypt_container(args.infile, _passphrase(args.passphrase_env))
    zf = _open_payload(payload)
    name = _keystore_entry(zf)
    data = zf.read(name)
    print(f"[ok] 解密通过 · {name} {len(data)} B · sha256 {_sha256(data)}")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_ks = os.path.join(tmp, name)
        with open(tmp_ks, "wb") as f:
            f.write(data)
        expect = args.expect or CERT_FPR
        rc = _check_fpr(tmp_ks, expect, args.storepass)
    return rc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="安卓签名密钥加密备份/恢复（.ccks 容器）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("backup", help="把 keystore 加密打包")
    b.add_argument("--keystore", default="android/couplechat-release.keystore")
    b.add_argument("--out", required=True)
    b.add_argument("--passphrase-env", default="CC_KS_PASS")
    b.set_defaults(func=cmd_backup)

    l = sub.add_parser("list", help="列出容器内容")
    l.add_argument("--in", dest="infile", required=True)
    l.add_argument("--passphrase-env", default="CC_KS_PASS")
    l.set_defaults(func=cmd_list)

    r = sub.add_parser("restore", help="解出 keystore")
    r.add_argument("--in", dest="infile", required=True)
    r.add_argument("--out", default="android/couplechat-release.keystore")
    r.add_argument("--passphrase-env", default="CC_KS_PASS")
    r.add_argument("--force", action="store_true")
    r.add_argument("--expect", default=None, help="期望的证书 SHA256 指纹（带不带冒号都行）")
    r.add_argument("--storepass", default=None, help="keystore 口令，用于指纹自检")
    r.set_defaults(func=cmd_restore)

    v = sub.add_parser("verify", help="解密并自检指纹，不落地任何文件")
    v.add_argument("--in", dest="infile", required=True)
    v.add_argument("--passphrase-env", default="CC_KS_PASS")
    v.add_argument("--expect", default=None)
    v.add_argument("--storepass", default=None)
    v.set_defaults(func=cmd_verify)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
