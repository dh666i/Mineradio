# 发布流程

## 仓库发布边界

- 正式仓库：`https://github.com/dh666i/Mineradio`。
- `package.json` 中 `build.publish` 与 `mineradio.update` 必须指向 `dh666i/Mineradio`。
- 当前源码与稳定安装版为 `3.0.1`。
- 更新元数据只从 GitHub 官方 HTTPS 获取；安装包镜像会在下载前测速，最终文件必须通过 Release 大小与摘要校验；存在 Authenticode 签名时还会继续校验签名。
- 技术 `appId` 使用 `com.dh666i.mineradio`，用户数据目录使用 `%APPDATA%\dh666i\Mineradio`；界面产品名保持 `Mineradio`。

## v3.0.1 发布

- Tag：`v3.0.1`
- 标题：`Mineradio v3.0.1`
- 使用 `npm run build:win` 生成无签名安装包，并确认 `Get-AuthenticodeSignature` 返回 `NotSigned`。
- 使用 GitHub Actions 的 macOS runner 按架构执行 electron-builder，生成 `x64` 与 `arm64` 两套 DMG/ZIP 预览包；使用 ad-hoc 本地完整性签名，不使用 Apple Developer 身份签名或公证。
- `v1.3.0` 至公开版 `v1.5.4` 使用自签名 Authenticode；`v3.0.1` 起恢复无签名发布。
- 公开版 `v1.5.4` 的旧更新器要求同证书安装包，因此现有用户首次升级 `v3.0.1` 必须从 Release 手动下载并覆盖安装。`v3.0.1` 之后的版本可使用新的摘要校验和差量更新链路。
- 固定 NSIS `guid` 为 v1.2.0 使用的 `9733721a-009e-52bc-b705-49059cd80258`，修改 `appId` 时不得改变升级身份。
- Release 不上传快速补丁文件，只上传 Windows 完整安装包、blockmap、`latest.yml`、macOS 双架构预览包和统一 SHA256 文件。
- `latest.yml` 必须由最终安装包生成，不得在生成元数据后重新签名、修改或替换安装包。
- 验证 100%、125%、150%、175%、200% 缩放，以及不同缩放显示器之间拖动窗口。

发布资产：

- `dist/Mineradio-3.0.1-Setup.exe`
- `dist/Mineradio-3.0.1-Setup.exe.blockmap`
- `dist/latest.yml`
- `dist/Mineradio-3.0.1-x64.dmg`
- `dist/Mineradio-3.0.1-x64.zip`
- `dist/Mineradio-3.0.1-arm64.dmg`
- `dist/Mineradio-3.0.1-arm64.zip`
- `dist/Mineradio-3.0.1-SHA256SUMS.txt`

## v1.2.0 发布

- Tag：`v1.2.0`
- 标题：`Mineradio v1.2.0`
- 必须发布为非 draft、非 prerelease 的 latest Release，供应用内更新检测使用。
- 安装器、可执行文件、README 和 Release 正文统一使用产品名 `Mineradio`，不添加版本类型后缀。
- 该历史版本仍沿用旧技术标识和用户数据目录；升级到 `1.3.0` 时由应用执行一次非破坏性数据迁移。
- `v1.2.0` 历史安装包未签名；`v1.3.0` 至公开版 `v1.5.4` 使用自签名 Authenticode；`v3.0.1` 起恢复无签名发布。所有版本都必须提供 SHA256。
- 安装包必须包含 `LICENSE`、`NOTICE.md`、`PRIVACY.md` 和 `SECURITY.md`。

发布资产：

- `dist/Mineradio-1.2.0-Setup.exe`
- `dist/Mineradio-1.2.0-Setup.exe.blockmap`
- `dist/latest.yml`
- `dist/Mineradio-1.2.0-SHA256SUMS.txt`

## 发布前检查

- 确认 `package.json` 与 `package-lock.json` 版本一致，发布源指向 `dh666i/Mineradio`。
- 使用 `npm ci` 从锁文件安装依赖，并要求 `npm audit --omit=dev` 为零；完整 `npm audit` 中仅构建期依赖的上游告警必须单独复核并记录，不得忽略任何会进入正式包的运行时漏洞。
- 确认 `.cookie`、`.qq-cookie`、`updates/`、`node_modules/`、`dist/` 和其他可执行产物没有进入 Git。
- 运行 `git diff --check`、Node 语法检查、前端内联 CSS/JavaScript 解析。
- 先执行 `npm run build:win:dir` 核对打包版本、EXE 元数据、许可证和运行时依赖，再执行 `npm run build:win` 生成正式无签名安装包。
- 对无签名正式包运行 `Get-AuthenticodeSignature`，状态应为 `NotSigned`；随后验证静默安装、覆盖升级和卸载。
- 使用 GitHub 已发布的 `v1.5.4` 安装包与 blockmap 验证 `v3.0.1` 差量路径，不得使用摘要不一致的本地历史产物冒充发布基线。
- 使用本机安全软件扫描最终安装包，并生成 SHA256 校验文件。
- 下载 GitHub Actions 生成的 macOS 产物，核对文件名、架构、版本、ad-hoc 签名和摘要；在没有真机结果前必须标注为预览版。

## 发布后验证

- 核对 tag 与构建提交一致，Release 为非 draft、非 prerelease、latest。
- 从 GitHub Release 重新下载全部资产并复算 SHA256，确认与本地发布文件一致。
- 检查 `/releases/latest`、`latest.yml` 和安装包下载地址，确认应用内更新可以发现目标版本。
- README、SECURITY、CHANGELOG 和 Release 正文必须与已发布状态一致。
