# 隐私与用户数据说明

Mineradio 是本地桌面应用。项目不应把用户登录状态、Cookie、播放历史、搜索历史、自定义封面、自定义歌词或本地缓存提交到 GitHub。

## 本地数据

应用可能在本机保存以下数据：

- 使用 Electron `safeStorage` 和 Windows DPAPI 加密保存的网易云音乐登录 Cookie
- 使用 Electron `safeStorage` 和 Windows DPAPI 加密保存的 QQ 音乐登录 Cookie
- 使用 Electron `safeStorage` 和 Windows DPAPI 加密保存的 YouTube OAuth 登录令牌
- 搜索历史
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
- 用户账号信息、Cookie、Token、维护者 OAuth 客户端源文件、二维码登录状态

## 第三方平台

用户通过网易云音乐、QQ 音乐、Google 或 YouTube 等第三方平台登录时，应遵守对应平台的用户协议。YouTube Data API 请求仅在用户明确选择 YouTube Music 搜索或账号内容后发起；点击视频会交由系统浏览器在 YouTube 或 YouTube Music 官方页面打开，Mineradio 不使用隐藏 IFrame 播放 YouTube 内容。Mineradio 不提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

YouTube 登录会在系统浏览器的 Google 官方页面中完成。Mineradio 不接收或保存 Google 密码；发行包只包含应用自身的桌面 OAuth 公共客户端标识，用户令牌仅保存在当前 Windows 用户的加密存储中。
