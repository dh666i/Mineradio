# Security Policy

## Supported Versions

当前只维护最新公开版本。

当前维护的源码与稳定二进制版本为 `3.0.2`；安装包只通过 `dh666i/Mineradio` Releases 发布。

## Installer Safety Notice

`v1.0.10` 及更早旧安装包不再建议继续安装或传播。请将旧 `.exe` 安装包视为不可信历史产物并隔离保留。

只应从 `dh666i/Mineradio` Releases 下载安装包并核对摘要。公开版 `v1.3.0` 至 `v1.5.4` 使用自签名 Authenticode；`v3.0.1` 起使用无签名安装包，必须以 Release 中的 SHA256 和 `latest.yml` 中的 SHA512 摘要为准，应用内更新也会在打开安装包前重新校验大小与摘要。

`v1.5.4` 的旧更新器会拒绝打开无签名安装包，因此从该版本升级到 `v3.0.1` 时必须手动下载并覆盖安装。

`v3.0.2` 的 macOS x64 / arm64 文件属于预览包，只使用无开发者身份的 ad-hoc 本地完整性签名，未进行 Apple Developer ID 签名或 Apple 公证。首次打开可能需要通过 Finder 右键“打开”或“系统设置 > 隐私与安全性”手动放行。

## Reporting a Vulnerability

如果你发现安全问题，请通过 [dh666i/Mineradio Security Advisories](https://github.com/dh666i/Mineradio/security/advisories/new) 私下报告；一般安全建议可使用 [GitHub Issues](https://github.com/dh666i/Mineradio/issues)。

请不要在公开 Issue 中直接贴出 Cookie、Token、账号信息、私密链接或可复现的敏感数据。

## Sensitive Data

Mineradio 不应收集或上传用户 Cookie。用户登录状态应保存在本地用户数据目录中。

如果你要提交问题反馈，请先确认没有附带：

- `.cookie`
- `.qq-cookie`
- 本地音乐文件
- 用户账号截图
- 调试日志中的 Cookie、Token 或隐私路径
