# 安卓签名密钥：为什么不能进仓库，以及怎么备份

## 一句话

`com.couplechat.app` 的**升级资格**由签名证书决定，证书由 `android/couplechat-release.keystore` 里的私钥产生。这把私钥不进 git、不进 Release，所以必须单独备份——丢了就只能"卸载重装"，而卸载会清掉 App 私有目录里的身份密钥与全部历史。

## 现状（2026-11-23 实测）

| 项 | 值 |
|---|---|
| keystore 路径 | `android/couplechat-release.keystore`（仅本地） |
| 容器格式 / 大小 | PKCS12 / 2,720 B |
| keystore 文件 sha256 | `9bc71b9c11d43ed948ccac19ee4e94554f1c0ddba80301b438bd9db3745217d1` |
| 别名 | `couplechat`（`PrivateKeyEntry`） |
| 算法 | RSA 2048 / `SHA384withRSA` 自签名 |
| DN | `CN=CoupleChat, OU=CoupleChat, O=CoupleChat, L=Local, C=CN` |
| 序列号 | `5cb9b586c1808a71` |
| 有效期 | 2026-11-22 → 2056-11-14 |
| **证书 SHA-256 指纹** | `5D:05:CE:76:C2:76:48:22:D4:85:54:17:1D:BE:64:42:E0:12:04:52:A4:DC:74:D4:7C:C8:D5:08:F8:59:69:91` |
| keystore 口令 | `couplechat`（写在 `android/build.py`） |
| 进 git 了吗 | 没有（`.gitignore:16`） |
| 进 Release 资产了吗 | 没有（只有两个 zip：apk/exe + 说明 + SHA256.txt） |

APK 的实际签名证书（Android 用它判定能否覆盖升级）与此逐位一致：

```
$ apksigner verify --print-certs android/dist/CoupleChat-1.8.apk
Signer #1 certificate SHA-256 digest: 5d05ce76c2764822d48554171dbe6442e0120452a4dc74d47cc8d508f8596991
```

## 为什么坚决不提交

公开私钥 = 把"发布这个 App 的签名权"公开。任何人可以签一个改过的包，Android 会认作你自己的升级，从而**覆盖用户手机上已装的版本**并读取其 App 私有目录（IndexedDB 里的历史与身份都在那里）。这不是洁癖，这是唯一后果。

同理也不要放进 Release 资产、不要贴到 issue、不要写进 `build.py` 之外的任何文本。

## 备份与恢复（工具已入库：`tools/keystore-backup.py`）

本机没有 7z / openssl / gpg，所以用 Python 的 `cryptography` 做容器：**scrypt(N=2¹⁵, r=8, p=1) 派生密钥 + AES-256-GCM 认证加密**，格式见脚本头部注释（magic `CCKS1\n` / version / salt 16B / nonce 12B / ciphertext / tag 16B）。

```bash
# 备份（口令走环境变量，别写命令行——会进历史）
export CC_KS_PASS='<你的口令，20+ 字符>'
python tools/keystore-backup.py backup \
    --keystore android/couplechat-release.keystore \
    --out ../couplechat-backup/couplechat-keystore-20261123.ccks

# 只看内容
python tools/keystore-backup.py list --in <file.ccks>

# 校验（解密 + keytool 指纹比对，不落地文件）
python tools/keystore-backup.py verify --in <file.ccks> --storepass couplechat

# 恢复
python tools/keystore-backup.py restore --in <file.ccks> \
    --out android/couplechat-release.keystore --storepass couplechat
```

容器内的明文是一个 zip：`couplechat-release.keystore` + `README.txt` + `SHA256.txt`——即使将来这个脚本丢了，用任何解 zip 的方式也能把 keystore 取出来。

口令错或容器被改动 → GCM 认证失败，退出码 `3`，**不会产出半个坏 keystore**。

## 每次发版必做的一条校验

```bash
apksigner verify --print-certs android/dist/CoupleChat-<ver>.apk | findstr /i SHA-256
# 必须是 5d05ce76c2764822d48554171dbe6442e0120452a4dc74d47cc8d508f8596991
```

不是这个值 = 签错了密钥，装到用户手机上必然 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。

## 如果确实丢了私钥

1. 老用户必须**先卸载**才能装新包 —— 卸载同时删掉身份与历史；
2. 双方重新扫码配对（指纹会变，因为身份密钥随 App 数据重生）；
3. 旧历史的解密密钥随身份一起没了，读不回来；
4. 无法"再生成一把一样的"：私钥不可由证书推导。

所以：**备份是唯一解**。若要彻底避免单点，另立一条路线是把私钥托管到 CI secret（GitHub Actions secrets），本地与流水线各留一份。

## 相关

- 构建：`android/build.py`（`apksigner sign --ks ...`，首跑自动 `keytool -genkeypair` 生成）
- 说明：`README.md`「手机端（安卓 APK）」章节
- 仓库：https://github.com/CC066610/couple-chat
