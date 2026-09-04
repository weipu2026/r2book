# r2book — 私人书库

把小说存进 Cloudflare R2，手机用 Readingo 通过 WebDAV 拉取阅读。全部跑在 Workers 免费额度内，零运行时依赖。

```
电脑浏览器 → 上传端网页 → R2
手机 Readingo → Worker（Basic Auth）→ R2
```

## 它是什么

不是通用网盘，是**只读书库**。Readingo 的设计是「下载到本地再读」，所以整个读取路径只有两个动作：列目录、下载。Worker 因此只需要实现 WebDAV 的只读子集（`OPTIONS / PROPFIND / GET / HEAD`），不需要 PUT/MOVE/COPY/LOCK，也就不可能被误删。

同时还输出 **OPDS**（电子书目录协议）。安卓端 Readingo 1.50 还没有 OPDS 入口，iOS 1.51 已有；端点现在就开着，等安卓跟进后填进去即可，不用改代码。

## 存储结构

```
_meta/root.json          分类清单 + 每类的 count/bytes
_meta/cat/<slug>.json    单个分类的书目（按分类分片）
books/<slug>/<file>      正文
_trash/<ts>/<file>       软删除暂存
```

**为什么元数据要按分类分片**：如果所有书挤在一个大 JSON 里，每次列目录都要解析全量数据。按 3MB/本、每条记录约 200 字节估算，1300 本就是 250KB，`JSON.parse` 就要 2~3ms，逼近 Workers Free 的 10ms CPU 上限。分片之后，单次请求只解析当前分类那一小份，**成本与书库总量无关**。

分片键是分类 slug，分类在上传端可自由增删改，重命名只改显示名、slug 不变，文件不用搬运。

## 部署

两条路线任选：**GitHub Actions 一键部署**（推荐，配一次以后 push 即部署）或本地命令行。

### 路线 A：GitHub Actions 一键部署

把源码推到 GitHub 仓库后，在仓库 **Settings → Secrets and variables → Actions** 里配 6 个 Secret，然后 push 到 `main`（或手动 Run workflow）即完成部署：

| Secret | 值 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | API Token | 权限见下方说明 |
| `CLOUDFLARE_ACCOUNT_ID` | 账户 ID | dashboard 首页右侧栏，32 位十六进制 |
| `ADMIN_PASSWORD` | 强口令 | 上传端登录 |
| `SESSION_SECRET` | 长随机串 | `openssl rand -hex 32` 生成 |
| `DAV_PASSWORD` | 另一口令 | Readingo 只读口令，**与管理口令不同值** |
| `CUSTOM_DOMAIN` | 你的域名 | 可选；**留空则用默认的 workers.dev 地址**。域名只存在 Secrets 里，仓库零痕迹，换域名不用改代码 |

**API Token 权限**（Cloudflare dashboard → My Profile → API Tokens → 创建，用「编辑 Cloudflare Workers」模板打底再按需加）：

- Account · Workers Scripts · **Edit**（模板自带，部署 Worker）
- Account · Account Settings · **Read**（模板自带）
- Account · Workers R2 Storage · **Edit**（建桶/读写书库；**较新的模板已自带**，若你的模板没有再手动加）
- Zone · DNS · **Edit**（**绑自定义域名时才加**，`custom_domain` 自动建 DNS 记录用；用默认 workers.dev 地址可省）

> 不用单独加 `Zone · Zone · Read`——绑域名时 `DNS · Edit`（在指定 Zone 上）已足够。模板不带任何 Zone 级权限。

Workflow 做的事：语法检查 → 确保 R2 桶存在（幂等）→ 把 `CUSTOM_DOMAIN` 注入部署配置 → 部署 Worker → 把三个密码类 Secret 同步到 Worker（secrets 设置后立即生效，无需二次部署）。全部可重复执行，push 到 `main` 就是日常发布。

改 GitHub Secrets 里的密码或域名后，手动 Run 一次 workflow 即可生效。

> **Fork / 换域名部署**：域名不是仓库里的配置，而是 `CUSTOM_DOMAIN` Secret——Fork 者配好自己的域名即可，**仓库里没有任何需要改的域名**。`bucket_name` 建议换成自己的随机串；首次部署 workflow 会自动建桶。不绑域名也能用，默认地址是 `https://r2book.<你的 workers.dev 子域>.workers.dev`。

### 路线 B：本地命令行

前置：Node 18+、一个 Cloudflare 账号、一个已托管在 Cloudflare 的域名。

```bash
npm install

# 1. 先建 R2 桶，名字换成你自己的随机串
npx wrangler r2 bucket create r2book-7f3a
#   把 wrangler.toml 里的 bucket_name 改成同一个名字

# 2. 设置密钥（生产环境，不会进仓库）
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DAV_PASSWORD

# 3. 要绑自定义域名：取消 wrangler.toml 里 [[routes]] 的注释填上你的域名
#    （不绑则跳过，用默认的 workers.dev 地址），然后部署
npm run deploy
```

本地开发：`cp .dev.vars.example .dev.vars` 填好，然后 `npm run dev`。

### 三个密钥

| 密钥 | 用途 | 建议 |
|---|---|---|
| `ADMIN_PASSWORD` | 上传端登录 | 强口令 |
| `SESSION_SECRET` | Cookie 的 HMAC 签名密钥 | 任意长随机串 |
| `DAV_PASSWORD` | Readingo 连接用的只读口令 | **与管理口令设成不同的值** |

分离的意义：手机里保存的是 `DAV_PASSWORD`，即便手机丢失，对方也读不了书库之外的东西、动不了管理接口和书目——书库 `/books/` 对它完全只读；唯一能写的是 `/backup/` 备份区，且有单文件 5MB + 条目 300 双重防护（最多约 1.5GB），不影响正文书库。

## 手机端连接（Readingo）

书架右上角 `⋮` → 远程书籍 / WebDAV → 填：

- 地址：`https://你的域名`（来自 `CUSTOM_DOMAIN` Secret，或部署输出的 workers.dev 地址）
- 账户：随便填，比如 `book`
- 密码：`DAV_PASSWORD`

刷新后就能看到分类和书目，点击即下载到本地，之后离线可读。

**进度备份**（建议顺手配上）：Readingo「我的 → 备份与恢复 → WebDAV」另填一次，地址用 `https://你的域名/backup/`。这是唯一可写区——只放进度 JSON，单文件限 5MB、总条目 300；`/books/` 书库永远只读。注意：重传同名书后，手机里已下载的旧版不会自动更新，需删除后重新下载。

iOS 1.51+ 另有 OPDS 入口，地址填 `https://你的域名/opds/`。分类书目按书名统一排序、按页输出（每页 100 条，`rel="first/previous/next/last"` 翻页），大书架也不会一次塞爆 feed。

## 上传文件

浏览器打开域名，用 `ADMIN_PASSWORD` 登录：

- 拖入或选择文件，支持多选，自动显示进度
- **GBK 自动转 UTF-8（仅对 txt）**：中文小说 txt 大量是 GBK，浏览器探测后转成 UTF-8 再上传；epub/pdf/mobi 等二进制文件原样上传，不会被转码损坏
- **书名自动清洗**（可关）：剥掉 `【笔趣阁 www.xxx.com】` 之类广告片段，`《》`书名号和正常括号不受影响
- **同名查重**：书库里已有同名书时先确认再覆盖，不会静默丢旧版
- 删除是软删除，进回收站可恢复，回收站支持**一键清空**；软删超期（默认 30 天）的文件会在下次打开回收站时自动清理，不用手动管
- 支持勾选后**批量删除 / 批量移动分类**
- 每本书可**移动分类 / 改名**（行内「移动」按钮），不用删了重传
- 上传前会拦截 Word 文档（`.doc`/`.docx`）——Readingo 打不开，需先用 Calibre 在电脑上转成 txt 或 epub

## 维护

**重建索引**：上传端顶部有按钮。用于上传中断导致索引错乱，或你用 rclone 直接往 R2 灌过文件之后。它按分类分批执行，每批一个 Worker 调用，不会顶到 CPU 上限。

**导出书目**：顶部「导出书目」按钮下载全库书目清单 JSON（书名/分类/大小/时间），供本地留存备份。清单最多覆盖 45 个分类。

**孤儿文件**：文件写进 R2 了但索引更新失败时会出现。重建索引即可找回。

**回收站自动过期**：软删对象 key 自带时间戳 `_trash/<ts>/<file>`，打开回收站时顺手删掉超期项（默认 30 天，`TRASH_TTL_MS` 可调）——不加任何后台定时任务、零额外请求；单次至多清 45 个，没清完的下次打开再清。

**容量**：顶栏常驻显示已用 / 10GB。R2 免费额度是 10GB 存储 + 出站流量免费。

## 设计约束备忘

改动代码前值得知道的几件事：

- **不开 `nodejs_compat`**，纯 Web API，全部逻辑在 `src/worker.js` 单文件里
- **静态资源走 `[assets]`**，`index.html` / `app.js` / `style.css` 由边缘直出，不消耗 Workers 请求数。只有 `/`、`/books/*`、`/opds/*`、`/api/*` 会执行 Worker（见 `wrangler.toml` 的 `run_worker_first`）
- **拒绝 `Depth: infinity`**，返回 RFC 4918 允许的 403 + `propfind-finite-depth-lock`，强制客户端逐层列目录
- **`/books/` 只读、`/backup/` 可写**是两套 Allow：书库不存在被 DAV 客户端改写的可能；备份区有单文件 5MB（`BACKUP_MAX`）+ 条目 300 双重防护
- **批量接口分批上限**：`/api/batch-delete` 单次 4 项（每本约 8 次 subrequest，4×8=32，留 CAS 冲突余量）、`/api/move` 单次 3 项（每本约 14 次，3×14=42）——Workers Free 单次调用 50 次 subrequest 是硬上限，前端自动按对应数量分批
- **元数据读写带乐观锁**：`updateMeta()` 用 R2 的 `onlyIf: { etagMatches }` 检测冲突并重试三次，避免并发上传时「读—改—写」静默丢更新
- **GET 支持 Range**，Content-Range 的总长度从分片元数据取，省掉一次额外的 head 请求
- **列表统一排序**：WebDAV / OPDS / 管理页共用 `Intl.Collator('zh', { numeric: true })` 按书名升序（中文按拼音、数字按数值），三类视图书序一致
- **WebDAV 只读语义**：集合 href 带结尾斜杠（RFC 4918）；OPTIONS 不回 `MS-Author-Via`，避免客户端误判可写
- **上传原样放行 zip**：zip 不做解包处理，如需解包请先在电脑上解开再传
- **文件名原样处理**：删除/移动/恢复按索引里的原始文件名匹配（`validFile` 强校验不含路径分隔符），rclone 直灌的特殊字符文件名也能管理
- **暴力破解防护**：WebDAV Basic Auth 与上传端登录各自独立计数，同 IP 连错 `BRUTE_LIMIT`（默认 5）次锁 `BRUTE_LOCK_MS`（默认 10 分钟）。纯内存 Map，零额外请求，尽力而为（Workers 多 isolate 不共享计数）；无凭据探测不计入失败，Map 有大小上限防轮换 IP 撑爆内存
- **OPDS 分页**：分类 feed 每页 `OPDS_PAGE_SIZE`（默认 100）条，`rel="first/previous/next/last"` 链接翻页，页码越界自动夹到最后一页
- **管理 API 全部限方法**：改数据接口只认 POST/DELETE，GET 一律不触发（405/404）——SameSite=Lax 下跨站顶级 GET 导航也带 cookie，方法限制堵住「点链接即改库」的 CSRF 链
- **软删 key 防碰撞**：回收站 key 含分类（`_trash/<ts>/<slug>/<file>`），不同分类同名书不会互相覆盖
- **上传回滚**：写正文成功但索引写失败时，新增场景自动删除刚写的对象；覆盖场景保留对象并提示重建索引（旧版已覆盖不可找回）
- **OPDS 搜索 CPU 预算**：搜索解析最多 20 个分类 / 累计 10000 本（约 8ms），超出即止，不顶 10ms CPU 硬限；分类超过 20 个时搜索不全，属可接受的取舍
- **重建索引页数**：单分类最多读 45 页（45000 本），超出明确报错而非写截断索引
- **HMAC 密钥缓存**：`importKey` 按 secret 复用 `CryptoKey`，鉴权路径 CPU 降约 40%
- **流式搬运**：软删/移动/恢复用 `src.body` 管道传给 R2，不整体读入内存，单本上限不受 128MB isolate 内存约束
- **冗余数据不重试**：`syncCatToRoot` 只 1 次 CAS（root.json 是聚合缓存，冲突即放弃、下次操作自愈），把 subrequest 预算让给关键写入
- **OPDS feed 时间**：`<updated>` 取自分类书目的 max mtime（非请求时刻），客户端不会误判每次都有更新

## 免费额度核算

按日均 30~60 次请求算：

| 限制 | 免费额度 | 实际占用 |
|---|---|---|
| Workers 请求 | 10 万/天 | 几十次 |
| Workers CPU | 10ms/请求 | 读路径 2~4ms |
| Subrequest | 50/请求 | 单次上传 6 次 |
| R2 存储 | 10 GB | 3MB/本 → 约 3300 本 |
| R2 Class A | 100 万/月 | 远未触及 |

真正的天花板不在服务端，而在 **Readingo 单目录列表的渲染能力**——单个分类超过约 300 本时 App 会开始卡。所以分类还是建议分细一点，但这是客户端体验问题，不是架构限制。
