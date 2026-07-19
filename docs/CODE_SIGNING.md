# Windows 代码签名

Mineradio 的 Windows 发布构建默认使用 Authenticode 签名。当前采用本地自签名证书，证书只用于确认安装包与可执行文件来自同一次受控构建，不能建立 Windows SmartScreen 公共信誉。

## 默认发布构建

```powershell
npm install
npm run build:win:dir
npm run build:win
```

首次执行时，构建脚本会自动在仓库根目录的 `.cert/` 生成三年有效期的自签名证书。PFX 和经过 Windows DPAPI 加密的密码文件都已被 `.gitignore` 排除，不得提交、上传为 Release 资产或发送给其他人。

`npm run build:win:dir` 会签名解包目录中的主程序。`npm run build:win` 会继续签名 NSIS 卸载器和最终安装包，并要求 RFC 3161 时间戳。缺少签名、签名失败或时间戳服务不可用时，发布构建会失败。

构建脚本会优先复用 `node_modules/electron/dist` 和本机已安装的 Windows SDK `signtool.exe`。本机没有签名工具时，electron-builder 会下载配置中锁定的工具版本。

手动重新生成本地证书：

```powershell
npm run cert:self-sign -- -Force
```

证书密码由脚本随机生成，凭据文件只能由生成它的 Windows 用户在同一台计算机上解密。后续发布不得重新生成证书；迁移构建机前必须在旧机器上安全导出并迁移同一份 PFX 与密码。证书丢失或更换指纹会导致已安装版本拒绝打开新安装包。

当前自签证书到期前必须先发布支持证书轮换的桥接版本，再切换到新证书；不能等证书过期后直接替换。

## 显式无签名构建

仅调试打包流程时可以使用：

```powershell
npm run build:win:dir:unsigned
npm run build:win:unsigned
```

无签名构建不得发布到 GitHub Releases。

## 使用外部证书

构建脚本也支持 electron-builder 的标准环境变量：

```powershell
$env:WIN_CSC_LINK = 'C:\secure\mineradio.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<certificate password>'
npm run build:win
```

环境变量优先于 `.cert/` 中的本地证书。CI 中应从加密 Secret 注入这些变量，不得把密码写入 `package.json`、工作流日志或仓库文件。

## 验证

签名构建结束后会自动检查主程序和安装器的 Authenticode 签名及时间戳，也可以单独运行：

```powershell
npm run verify:win:signatures
```

自签名证书没有公共信任链，因此 Windows 仍可能显示“未知发布者”或 SmartScreen 警告。签名存在不等于文件安全，Release 仍必须提供 SHA256/SHA512 摘要并保留应用内更新的摘要校验。
