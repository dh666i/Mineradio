# Mineradio v1.3.0

## 本次更新

- 新增 Windows 系统媒体面板、媒体键、锁屏歌曲信息和任务栏缩略图播放按钮。
- 关闭主窗口时隐藏到系统托盘，托盘可恢复窗口、控制播放或退出程序。
- 主窗口、登录窗口和安装器支持 Per-Monitor V2 DPI，并适配不同缩放比例的多显示器。
- Windows 安装包、主程序、辅助程序和卸载器默认使用同一份自签名 Authenticode 证书。
- 更新检查明确区分最新、可更新和检查失败；完整安装包必须通过名称、大小、摘要与签名者校验。
- 停用会直接覆盖程序代码的快速补丁入口，更新统一使用完整安装包。
- 网易云与 QQ 音乐登录 Cookie 使用 Windows 本机加密存储。
- 增加升级前设置备份、最近备份恢复和脱敏诊断导出。
- 应用技术标识与用户数据目录独立迁移；旧目录保留，迁移成功的旧明文登录凭据会被清除。

## 安装提示

- 自签名证书不能建立 SmartScreen 公共信誉，Windows 仍可能显示未知发布者提示。
- 只从 `dh666i/Mineradio` Releases 下载，并核对 Release 提供的 SHA256。
- 更新安装包必须与当前 Mineradio 使用相同证书签名；证书不一致时应用会拒绝打开安装包。

## 发布文件

- `Mineradio-1.3.0-Setup.exe`
- `Mineradio-1.3.0-Setup.exe.blockmap`
- `latest.yml`
- `Mineradio-1.3.0-SHA256SUMS.txt`
