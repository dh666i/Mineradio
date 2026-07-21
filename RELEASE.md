# 发布流程

## 仓库发布边界

- 正式仓库：`https://github.com/dh666i/Mineradio`。
- `package.json` 中 `build.publish` 与 `mineradio.update` 必须指向 `dh666i/Mineradio`。
- 当前源码基线和稳定安装版为 `1.5.3`；README、SECURITY 与 Release 资产必须保持一致。
- 更新元数据只从 GitHub 官方 HTTPS 获取；安装包镜像会在下载前测速，最终文件仍须通过 Release 摘要与签名校验。
- 技术 `appId` 使用 `com.dh666i.mineradio`，用户数据目录使用 `%APPDATA%\dh666i\Mineradio`；界面产品名保持 `Mineradio`。

## v1.5.3 发布准备

- Tag：`v1.5.3`
- 标题：`Mineradio v1.5.3`
- 使用同一份持久化自签名证书构建所有后续版本；丢失证书会导致已安装版本拒绝自动打开新安装包。
- 构建与验证脚本必须匹配已发布证书指纹 `FD7B0DCE709B69C049336CE4817E340E62C8F174`。
- 固定 NSIS `guid` 为 v1.2.0 使用的 `9733721a-009e-52bc-b705-49059cd80258`，修改 `appId` 时不得改变升级身份。
- Release 不上传快速补丁文件，只上传完整安装包、blockmap、`latest.yml` 和 SHA256 文件。
- `latest.yml` 必须由签名完成后的最终安装包生成，不得通过第三方镜像发布或替换。
- 验证 100%、125%、150%、175%、200% 缩放，以及不同缩放显示器之间拖动窗口。

发布资产：

- `dist/Mineradio-1.5.3-Setup.exe`
- `dist/Mineradio-1.5.3-Setup.exe.blockmap`
- `dist/latest.yml`
- `dist/Mineradio-1.5.3-SHA256SUMS.txt`

## v1.2.0 发布

- Tag：`v1.2.0`
- 标题：`Mineradio v1.2.0`
- 必须发布为非 draft、非 prerelease 的 latest Release，供应用内更新检测使用。
- 安装器、可执行文件、README 和 Release 正文统一使用产品名 `Mineradio`，不添加版本类型后缀。
- 该历史版本仍沿用旧技术标识和用户数据目录；升级到 `1.3.0` 时由应用执行一次非破坏性数据迁移。
- `v1.2.0` 历史安装包未签名；后续版本默认使用自签名 Authenticode 并提供 SHA256。Release 正文仍须说明自签名证书不能建立 SmartScreen 公共信誉。
- 安装包必须包含 `LICENSE`、`NOTICE.md`、`PRIVACY.md` 和 `SECURITY.md`。

发布资产：

- `dist/Mineradio-1.2.0-Setup.exe`
- `dist/Mineradio-1.2.0-Setup.exe.blockmap`
- `dist/latest.yml`
- `dist/Mineradio-1.2.0-SHA256SUMS.txt`

## 发布前检查

- 确认 `package.json` 与 `package-lock.json` 版本一致，发布源指向 `dh666i/Mineradio`。
- 使用 `npm ci` 从锁文件安装依赖，并确认生产依赖和完整依赖的 `npm audit` 均无已知漏洞。
- 确认 `.cookie`、`.qq-cookie`、`updates/`、`node_modules/`、`dist/` 和其他可执行产物没有进入 Git。
- 运行 `git diff --check`、Node 语法检查、前端内联 CSS/JavaScript 解析。
- 先执行 `npm run build:win:dir`，核对签名、时间戳、打包版本、EXE 元数据、许可证文件和运行时依赖。
- 执行 `npm run build:win`，确认主程序、卸载器和安装包均完成签名，再在隔离目录验证静默安装、覆盖升级和卸载行为。
- 仅调试打包流程时使用 `npm run build:win:unsigned`；无签名产物不得发布。
- 使用本机安全软件扫描最终安装包，并生成 SHA256 校验文件。

## 发布后验证

- 核对 tag 与构建提交一致，Release 为非 draft、非 prerelease、latest。
- 从 GitHub Release 重新下载四个资产并复算 SHA256，确认与本地发布文件一致。
- 检查 `/releases/latest`、`latest.yml` 和安装包下载地址，确认应用内更新可以发现目标版本。
- README、SECURITY、CHANGELOG 和 Release 正文必须与已发布状态一致。
