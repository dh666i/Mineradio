# Security Policy

## Supported Versions

当前只维护最新公开版本。

当前受支持的源码与二进制版本为 `1.2.0`。安装包只通过 `dh666i/Mineradio` Releases 发布。

## Installer Safety Notice

`v1.0.10` 及更早旧安装包不再建议继续安装或传播。请将旧 `.exe` 安装包视为不可信历史产物并隔离保留。

上游安装包与本二开源码不是同一发行物。二开安装包发布后，只应从 `dh666i/Mineradio` Releases 下载并核对摘要。

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
