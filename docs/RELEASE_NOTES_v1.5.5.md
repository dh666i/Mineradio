# Mineradio v1.5.5

本版本完成 YouTube Music 搜索、Google 官方登录和个人内容接入，并整理综合搜索、账号界面与外部打开体验。

## YouTube Music

- 支持搜索歌曲、歌单和频道；YouTube 来源页内部提供综合、歌曲、歌单和频道分类。
- 支持结果分页与详情浏览；点击 YouTube 视频会交给系统浏览器在 YouTube Music 打开，不加入 Mineradio 播放队列。
- 默认综合搜索仅包含网易云和 QQ 音乐；YouTube 查询只会在用户明确选择 YouTube Music 来源并提交搜索后发起。
- YouTube 查询增加 10 分钟成功缓存、相同请求合并和请求限流，减少重复请求和配额消耗。

## Google 登录与个人内容

- 登录弹窗新增 YouTube，点击后直接在系统浏览器打开 Google 官方 OAuth 授权页面。
- 不需要填写 API Key 或导入 OAuth JSON；正式安装包已内置桌面 OAuth 公共客户端配置。
- 支持取消正在进行的授权、自动刷新登录令牌和退出账号。
- 登录后可浏览我的歌单、喜欢的视频和订阅频道，并查看对应详情；选择视频时由系统浏览器打开 YouTube Music。
- Mineradio 不接收或保存 Google 密码；用户 Access Token 和 Refresh Token 通过 Windows DPAPI 加密保存在当前电脑。

## 打开方式与界面

- 点击 YouTube 视频后由系统浏览器打开 YouTube Music；Mineradio 不将其作为隐藏音源加入内部播放队列。
- 本版本不使用后台隐藏的 YouTube IFrame Player，视频播放在 YouTube Music 官方页面完成。
- 网易云搜索新增综合结果视图，可同时查看单曲、歌手、专辑和歌单。
- 三平台登录和账号弹窗统一为按平台切换，移除旧“我两个都要”状态。
- 来源徽标使用完整的“网易云”“QQ 音乐”和“YouTube”名称。
- 删除设置中重复的“服务”页面；YouTube 登录、退出和个人内容统一从登录及账号入口管理。

## 安装提示

- 本版本继续使用自 `v1.3.0` 起沿用的同一份自签名 Authenticode 证书。
- 自签名证书不能建立 SmartScreen 公共信誉，Windows 仍可能显示未知发布者提示。
- 只从 `dh666i/Mineradio` Releases 下载，并核对 Release 提供的 SHA256。
- 从旧版本覆盖安装时，网易云与 QQ 音乐登录状态、播放设置、队列和本地用户资源应保留。
- YouTube Data API 使用项目共享配额；配额暂时耗尽时需要等待 Google 恢复。

## 发布文件

- `Mineradio-1.5.5-Setup.exe`
- `Mineradio-1.5.5-Setup.exe.blockmap`
- `latest.yml`
- `Mineradio-1.5.5-SHA256SUMS.txt`
