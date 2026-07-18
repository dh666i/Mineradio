# 发布流程

## 二开仓库发布边界

- 正式仓库：`https://github.com/dh666i/Mineradio`。
- `package.json` 中 `build.publish` 与 `mineradio.update` 必须指向 `dh666i/Mineradio`。
- 首个二开源码版本为 `1.2.0`；未上传并核验安装包前，不在 README 中声明可下载。
- 第三方更新镜像默认不优先使用；Release 必须同时提供源码，并保留 GPL 与 NOTICE。
- 二开安装包若继续使用 Mineradio 名称、Logo、`appId` 和用户数据目录，必须显著标记非官方；面向公众长期分发前应改用独立产品标识，避免覆盖原版安装和用户数据。

## v1.2.0 发布

- Tag：`v1.2.0`
- 标题：`Mineradio v1.2.0 社区二开版`
- 必须发布为非 draft、非 prerelease 的 latest Release，供当前二开版更新检测使用。
- 安装器欢迎页、README 和 Release 正文必须明确标注社区二开版、非原项目官方发行。
- 当前仍沿用 Mineradio 的 `appId` 和用户数据目录，覆盖安装前必须提醒用户备份原版数据；后续长期分发应切换独立产品标识。
- 安装包未签名，Release 正文必须说明 Windows SmartScreen 可能提示未知发布者，并提供 SHA256。
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
- 先执行 `npm run build:win:dir`，核对打包版本、EXE 元数据、许可证文件和运行时依赖。
- 执行 `npm run build:win`，在隔离目录验证静默安装、覆盖升级和卸载行为。
- 使用本机安全软件扫描最终安装包，并生成 SHA256 校验文件。

## 发布后验证

- 核对 tag 与构建提交一致，Release 为非 draft、非 prerelease、latest。
- 从 GitHub Release 重新下载四个资产并复算 SHA256，确认与本地发布文件一致。
- 检查 `/releases/latest`、`latest.yml` 和安装包下载地址，确认应用内更新可以发现 `v1.2.0`。
- README、SECURITY、CHANGELOG 和 Release 正文必须与已发布状态一致。
