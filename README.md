# Mineradio 1.2.0 非官方二开版

![Mineradio 暗场启动页](./docs/assets/readme/cinema-beat-smoke.png)

Mineradio 是一款 Windows 桌面沉浸式音乐播放器，把天气电台、搜索播放、歌词舞台、粒子视觉和 3D 歌单架组合成一个更接近现场感的私人音乐空间。

> 本仓库是 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的非官方二次开发版本，由 [dh666i](https://github.com/dh666i) 自 2026-07-18 起维护，基于上游提交 `6b13010`。原项目及本修改版本继续依据 GNU GPL v3 发布。

## 当前状态

当前源码版本：`1.2.0`

状态：网易云账号体验二开源码版。当前仓库尚未发布对应的 `1.2.0` 安装包，请勿将上游 `1.1.1` 安装包误认为本二开版本。

本次主要补全网易云登录后的桌面端体验：首页每日推荐、完整推荐列表、私人 FM，以及搜索结果的批量播放和入队能力。完整变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 下载或安装被拦截怎么办

小众 Electron 桌面软件、未签名安装包有时会被浏览器、Windows Defender 或 SmartScreen 提示风险。发布二开安装包后，请只从本仓库 Releases 下载，并核对文件摘要。

1. 浏览器下载栏提示风险时，打开下载列表，点这条下载右侧的 `...` 三个点，选择 `保留` / `仍要保留` / `显示更多` 后继续保留。
2. Windows SmartScreen 弹出蓝色拦截窗口时，点 `更多信息`，再点 `仍要运行`。
3. 如果杀毒软件明确显示木马、高危或已经隔离，不要强行运行；删除该文件后重新从本仓库 Release 下载，仍然异常请带截图反馈给维护者。

## 支持原作者

以下支持页和收款渠道属于 Mineradio 原作者 XxHuberrr，并非二开维护者。

[查看完整支持页](./docs/SUPPORT.md)

![Mineradio 作者支持渠道](./docs/assets/support/mineradio-author-support-poster.png)

## 核心特性

- Open-Meteo 天气电台，根据当前位置、城市和天气 mood 生成更合适的播放队列
- 首页以网易云每日推荐为主入口，支持完整列表、播放全部、随机播放和指定歌曲开始播放
- 网易云私人 FM 使用独立线性队列并自动补歌
- Wallpaper 银河首页背景，未播放状态保持干净的星河氛围
- 播放后切换到 Emily / 默认播放态视觉，歌词舞台与粒子舞台同步工作
- 基于节奏的电影镜头视觉系统
- 面向长播客和 DJ 曲目的专属视觉模式
- 歌词舞台、自定义歌词、歌词位置与视觉控制
- 自定义专辑封面上传与裁剪
- 右键唤起 3D 歌单架，支持歌单队列浏览
- 网易云音乐账号、搜索、歌单、播客、每日推荐和私人 FM 接入
- 搜索结果支持播放全部、批量入队和随机播放；登录网易云时 All 搜索优先网易云，QQ 音乐用于补源
- GitHub Releases 更新检测与下载入口
- 首次启动内置「默认测试」视觉用户存档，软件内默认视觉参数与该存档一致

## 使用说明

当前二开版先开放源码。Windows 安装包发布后，以本仓库 Releases 中带 `1.2.0` 版本号和摘要的安装包为准。

## 开发运行

```bash
npm install
npm start
npm run build:win
```

桌面版入口由 Electron 主进程加载本地服务。`npm run build:win` 会生成 Windows NSIS 安装包，产物位于 `dist/`。

## 更新机制

本二开版会请求 `dh666i/Mineradio` 的 GitHub Releases 检测新版本，不再读取上游 Release。远端版本高于本地版本时，应用内更新入口会展示 Release 内容、下载安装包到本机用户数据目录，并通过系统打开安装包。

本地验证更新链路时，可以通过 `MINERADIO_UPDATE_MANIFEST` 指向一个本地 manifest JSON 或 HTTP 地址来模拟线上 Release。

## 第三方音乐平台说明

Mineradio 不是网易云音乐、QQ 音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。

项目中的第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不会提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

## 用户数据与隐私

登录 Cookie、搜索历史、自定义封面、自定义歌词、节奏分析缓存等数据只应保存在本机用户数据目录或浏览器本地存储中，不应提交到仓库。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 致谢

Mineradio 原版由 XxHuberrr 主要设计与打造，本二开版本由 dh666i 维护。emily 作为早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此感谢。

同时感谢小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦在早期体验、测试反馈和发布准备中的帮助。

## 版权与授权

Original work Copyright (C) 2026 XxHuberrr.

Modifications Copyright (C) 2026 dh666i.

本项目采用 GPL-3.0 授权。详见 [LICENSE](./LICENSE)。

MR Logo、Mineradio 名称、界面视觉设计与原创视觉表达归作者所有；第三方依赖和第三方服务分别遵循其各自授权与服务条款。
