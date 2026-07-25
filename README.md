# Mineradio 1.5.5

![Mineradio 暗场启动页](./docs/assets/readme/cinema-beat-smoke.png)

Mineradio 是一款 Windows 桌面沉浸式音乐播放器，把天气电台、搜索播放、歌词舞台、粒子视觉和 3D 歌单架组合成一个更接近现场感的私人音乐空间。

## 项目说明

本项目基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 持续开发。由于上游项目目前更新较少，为继续完善实际使用体验，本仓库在遵守 GPL-3.0 许可证的前提下进行二次开发与维护。感谢原作者 [@XxHuberrr](https://github.com/XxHuberrr) 完成初始版本；完整版权与来源说明见 [NOTICE.md](./NOTICE.md)。

## 当前状态

当前源码版本：`1.5.5`

当前稳定安装版为 `v1.5.5`。Windows 安装包仅通过本仓库 Releases 发布。

`v1.5.5` 新增 YouTube Music 独立来源搜索、Google 官方 OAuth 登录、个人内容与系统浏览器打开，并整理搜索和三平台账号界面。完整变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 下载或安装被拦截怎么办

当前 `v1.2.0` 历史安装包未签名；从 `v1.3.0` 起使用自签名 Authenticode。自签名证书不具备公共信任链，浏览器、Windows Defender 或 SmartScreen 仍可能提示风险。请只从本仓库 Releases 下载并核对文件摘要。

1. 浏览器下载栏提示风险时，打开下载列表，点这条下载右侧的 `...` 三个点，选择 `保留` / `仍要保留` / `显示更多` 后继续保留。
2. Windows SmartScreen 弹出蓝色拦截窗口时，点 `更多信息`，再点 `仍要运行`。
3. 如果杀毒软件明确显示木马、高危或已经隔离，不要强行运行；删除该文件后重新从本仓库 Release 下载，仍然异常请带截图反馈给维护者。

## 核心特性

- Open-Meteo 天气电台，根据当前位置、城市和天气 mood 生成更合适的播放队列
- 首页以网易云每日推荐为主入口，支持完整列表、播放全部、随机播放和指定歌曲开始播放
- Home 提供我的歌单、红心歌曲、继续听、持久化播放队列和推荐内容入口
- 网易云私人 FM 使用独立线性队列并自动补歌
- Wallpaper 银河首页背景，未播放状态保持干净的星河氛围
- 播放后切换到 Emily / 默认播放态视觉，歌词舞台与粒子舞台同步工作
- 基于节奏的电影镜头视觉系统
- 面向长播客和 DJ 曲目的专属视觉模式
- 歌词舞台支持横竖屏自适应多行与三句上下文，并保留自定义歌词、双语/罗马音副行、网易云 YRC 与 QQ QRC 逐字高亮
- 自定义专辑封面上传与裁剪
- 右键唤起 3D 歌单架，支持歌单队列浏览
- 网易云音乐账号、搜索、歌单、播客、每日推荐和私人 FM 接入
- YouTube Music 提供独立来源的歌曲、歌单与频道搜索；仅在用户明确选择该来源后请求，点击视频会在系统浏览器打开 YouTube Music
- Google 官方 OAuth 登录，支持 YouTube 个人歌单、喜欢的视频和订阅频道
- 网易云发现页支持热门歌单、新碟、新歌、分类浏览，以及歌曲、歌手、专辑和歌单类型搜索
- 网易云与 QQ 音乐搜索支持分页、加载更多、单来源失败重试、播放全部、批量入队和歌曲快捷操作
- 支持专辑详情、歌手专辑、歌单收藏，以及本人普通网易云歌单的元数据编辑、删除、移除歌曲和曲序同步
- 播放队列支持 5000 首跨启动恢复、窗口分页、拖动/键盘排序、多选移除、撤销和保存为网易云歌单
- 10 段均衡器、音效预设、基础响度与峰值保护、输出设备选择和下一首预取
- 网易云顺序播放支持无缝衔接及 3 / 5 / 8 秒等功率交叉淡化，失败时自动回退普通切歌
- 播客支持前后 15 秒、播放倍速和睡眠定时
- 设置中心统一管理播放、性能、后台策略、快捷键、更新与辅助体验
- GitHub Releases 更新检测与下载入口
- Windows 媒体键、系统媒体面板、锁屏歌曲信息和任务栏播放控制
- 关闭窗口后继续在系统托盘运行，托盘可控制播放或明确退出
- Per-Monitor V2 DPI、多显示器缩放和自适应登录窗口
- 登录凭据本机加密、升级前设置备份和脱敏诊断导出
- 首次启动内置「默认测试」视觉用户存档，软件内默认视觉参数与该存档一致

## 使用说明

Windows 用户可从 [GitHub Releases](https://github.com/dh666i/Mineradio/releases/tag/v1.5.5) 下载带 `1.5.5` 版本号的安装包，并使用同一 Release 中的 SHA256 文件核对摘要。

## 开发运行

```bash
npm install
npm start
npm test
npm run build:win
```

桌面版入口由 Electron 主进程加载本地服务。`npm run build:win` 会生成 Windows NSIS 安装包，产物位于 `dist/`。

## YouTube Music 配置

正式版本中，用户从账号页点击 YouTube 后会直接在系统浏览器打开 Google 官方登录，不需要填写 API Key 或导入 OAuth JSON。YouTube 搜索、歌单、频道和个人内容统一使用登录后的只读 OAuth 授权。

维护者构建官方版本前需要：

1. 在 Google Cloud 项目中启用 `YouTube Data API v3`。
2. 在 Google Auth Platform 的“数据访问”中添加 `https://www.googleapis.com/auth/youtube.readonly`。
3. 配置 OAuth 同意屏幕，创建“桌面应用”类型的 OAuth 客户端并下载 JSON。
4. 将文件保存为 `.cert/google-oauth-desktop.json`，或通过 `MINERADIO_GOOGLE_OAUTH_CLIENT_FILE` 指定仓库外路径。
5. 测试构建使用 `npm run build:win:dir`；正式安装包构建会在缺少 OAuth 客户端时直接终止，避免发布无法登录的版本。

`.cert/` 已被 Git 忽略。桌面 OAuth 客户端属于公开客户端，随安装包提供后可以被提取；真正需要保护的用户 Access Token 和 Refresh Token 仍通过 Windows DPAPI 加密保存在各自电脑。面向公众发布前，应把 OAuth 应用切换到 Production，并按 Google 要求完成品牌和敏感权限验证。YouTube Data API 使用项目共享的每日配额，配额耗尽后需等待恢复或申请调整。

YouTube Data API 请求仅在用户明确选择 YouTube Music 搜索或个人内容时发起；视频结果通过系统浏览器在 YouTube Music 官方页面打开，不进入 Mineradio 播放队列，也不使用隐藏 IFrame 播放。

## 更新机制

Mineradio 会请求 `dh666i/Mineradio` 的 GitHub Releases 检测新版本。远端版本高于本地版本时，应用内更新入口会展示 Release 内容、下载并校验完整安装包，再由系统打开安装程序。

本地验证更新链路时，可以通过 `MINERADIO_UPDATE_MANIFEST` 指向一个本地 manifest JSON 或 HTTP 地址来模拟线上 Release。

## 第三方音乐平台说明

Mineradio 不是网易云音乐、QQ 音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。

项目中的第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不会提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

## 用户数据与隐私

登录 Cookie、搜索历史、自定义封面、自定义歌词、节奏分析缓存等数据只应保存在本机用户数据目录或浏览器本地存储中，不应提交到仓库。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 版权与授权

Modifications Copyright (C) 2026 dh666i.

本项目采用 GPL-3.0 授权。详见 [LICENSE](./LICENSE)。依据许可证要求保留的原始版权与来源声明见 [NOTICE](./NOTICE.md)。
