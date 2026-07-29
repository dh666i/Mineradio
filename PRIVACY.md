# 隐私与用户数据说明

Mineradio 是本地桌面应用。项目不应把用户登录状态、Cookie、播放历史、搜索历史、自定义封面、自定义歌词或本地缓存提交到 GitHub。

## 本地数据

应用可能在本机保存以下数据：

- 使用 Electron `safeStorage`（Windows DPAPI / macOS Keychain）保护的网易云音乐、QQ 音乐、酷狗音乐和汽水音乐登录 Cookie 或会话信息
- 使用 Electron `safeStorage`（Windows DPAPI / macOS Keychain）保护的 Spotify OAuth Token；Spotify Client ID 不是密钥，不保存 Client Secret
- 搜索历史
- 用户主动导入的公开分享歌单索引
- 自定义专辑封面
- 自定义歌词
- 歌词布局与视觉控制设置
- 本地节奏分析缓存
- 更新安装包下载缓存
- 自动轮换的本地设置备份

应用可以由用户主动导出脱敏诊断 JSON。诊断信息包含应用版本、运行环境、显示器缩放、播放状态和性能指标，不包含 Cookie、Token、歌曲名称或本机绝对路径。诊断文件只保存到用户选择的位置，不会自动上传。

这些数据用于本地体验，不属于开源仓库内容。

## 不应上传的内容

以下内容不应提交到 GitHub：

- `.cookie`
- `.qq-cookie`
- `updates/`
- `node_modules/`
- Electron 打包产物
- 用户上传的本地音乐文件
- 用户账号信息、Cookie、Token、二维码登录状态

## 第三方平台

用户通过网易云音乐、QQ 音乐、酷狗音乐、汽水音乐或 Spotify 登录时，应遵守对应平台的用户协议。Mineradio 不提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

天气电台在用户请求定位时会访问 `ipwho.is`，由该服务根据当前公网 IP 返回城市、经纬度和时区；应用不会向项目作者的服务器上传定位结果。用户也可以直接手动输入城市，不使用网络位置。
