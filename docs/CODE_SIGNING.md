# Windows 代码签名

Mineradio 从 `v3.0.1` 起默认发布无签名 Windows 安装包，与上游发布方式保持一致。公开版 `v1.3.0` 至 `v1.5.4` 曾使用同一份自签名 Authenticode 证书。

## 默认无签名发布

```powershell
npm install
npm run build:win:dir
npm run build:win
```

`package.json` 会显式设置 `signAndEditExecutable=false`。正式发布前必须对解包后的 `Mineradio.exe` 和最终安装包运行 `Get-AuthenticodeSignature`，两者状态都应为 `NotSigned`。

无签名不代表跳过完整性验证。每次 Release 必须同时发布 electron-builder 生成的 `latest.yml`、安装包 blockmap 和独立 SHA256 文件；应用内更新在打开安装包前会校验 GitHub 元数据、文件大小与 SHA512。

Windows SmartScreen 可能显示“未知发布者”。用户应只从 `dh666i/Mineradio` Releases 下载，并核对 SHA256。

## 从旧签名版本升级

`v1.5.4` 的旧更新器要求目标安装包具有相同 Authenticode 指纹，因此会拒绝打开无签名的 `v3.0.1`。从 `v1.5.4` 升级时需要手动下载并覆盖安装一次；用户数据目录不会因此删除。

`v3.0.1` 已支持在摘要校验通过后打开后续无签名版本，并支持 blockmap 差量下载。

## 显式自签构建

仓库保留自签脚本用于测试旧签名链路：

```powershell
npm run cert:self-sign
npm run build:win:dir:signed
npm run build:win:signed
npm run verify:win:signatures
```

自签 PFX 和经过 Windows DPAPI 加密的密码文件位于 `.cert/`，已由 `.gitignore` 排除。它们不得提交、上传为 Release 资产或发送给其他人。自签证书不能建立 SmartScreen 公共信誉，也不再是默认发布要求。

## 使用外部证书

显式签名脚本支持 electron-builder 的标准环境变量：

```powershell
$env:WIN_CSC_LINK = 'C:\secure\mineradio.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<certificate password>'
npm run build:win:signed
```

CI 中应从加密 Secret 注入这些变量，不得把密码写入 `package.json`、工作流日志或仓库文件。
