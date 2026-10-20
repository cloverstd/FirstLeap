# FirstLeap

一个安静、专注的个人英语课堂。支持新概念英语第一册讲解视频，以及四册课程、原音逐句逐词点读、循环精听、生词美音和同步高亮。

React + TypeScript + Vite 前端，shadcn/ui（Radix）+ Tailwind CSS v4 组件与样式，Go HTTP 服务，单一 Docker 镜像。Go 直接流式读取只读媒体目录，支持 Range、HEAD、条件请求；原始 H.264/AAC MP4 不转码。`ffprobe` 和 `ffmpeg` 用于元数据、缩略图与课文原音片段；讲解原视频不转码。无账号、无数据库。课文与讲解进度同步到服务端，浏览器保留本地缓存与离线待同步记录；电脑和手机共用一个学习档案。

## 本地开发

需要 Linux、Go 1.26、Node.js 22.12+、pnpm 9.15.9，以及 PATH 中的 ffprobe/ffmpeg。媒体目录应包含课程 MP4；测试仅使用临时生成的模拟文件，不需要 NAS。

```sh
pnpm install --frozen-lockfile
MEDIA_ROOT=/absolute/path/to/course DATA_ROOT=/tmp/firstleap-data go run ./cmd/firstleap
# 另一个终端
pnpm dev
```

打开 Vite 输出的本机地址。开发环境允许本地媒体目录；生产必须设置 `REQUIRE_CIFS=true`，验证媒体目录实际属于只读 CIFS 文件系统。不要将视频或真实连接配置复制进仓库。

```sh
go vet ./...
go test -race ./...
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

浏览器测试使用受控课程响应验证搜索、导航、完成状态、续播状态与故障恢复。真实视频的解码、随机拖动和续播需在已连接媒体的环境验证。

## 配置与接口

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | HTTP 端口 |
| `BIND_ADDRESS` | `0.0.0.0` | 监听地址；临时预览可限定为 `127.0.0.1` |
| `MEDIA_ROOT` | `/media` | 课程目录，只读 |
| `DATA_ROOT` | `/data` | 元数据与缩略图缓存，可写 |
| `TEXTBOOK_ROOT` | 未设置 | 原始教材 JSON、音频和课程目录，只读；准备结果在 `DATA_ROOT/textbooks` |
| `WEB_ROOT` | `web/dist` | 静态页面目录，镜像中为 `/app/web` |
| `DICTIONARY_ROOT` | `data/dictionary/ecdict` | 本地基础词库；镜像中为 `/app/dictionary/ecdict` |
| `REQUIRE_CIFS` | `false` | 生产设为 `true`，拒绝普通目录和可写 CIFS 挂载 |

- `GET /api/courses`、`GET /api/courses/ncese01`：课程信息、课节列表、`sourceAvailable` 与 `indexing` 状态。
- `GET/HEAD /api/lessons/{id}/video`：原视频流；支持 `Range`、`ETag`、`If-Range`。
- `GET /api/lessons/{id}/thumbnail`：缩略图，生成前返回 404。
- `GET /health/live`：进程存活；`GET /health/ready`：挂载可读且已有目录索引。

课节 ID 取相对路径的 SHA-256 前 128 位，不随挂载绝对路径变化；重命名文件会产生新 ID。目录每 5 分钟刷新；媒体状态每 15 秒检查，恢复后重新扫描。文件大小或修改时间变化后重新生成元数据。目录先展示，时长和缩略图后台依次补全。源失联时保留最后一次有效目录；不会把空目录当成正常课程源。

## GitHub Actions / GHCR

`.github/workflows/build-images.yml` 在 PR 上运行 Go、前端与浏览器测试并验证镜像构建。推送 `main`、`v*` 标签或手动触发时发布 `linux/amd64` 镜像至 `ghcr.io/cloverstd/firstleap`。

工作流使用 `GITHUB_TOKEN` 的 `contents: read` 和发布任务的 `packages: write` 权限。提供完整提交 SHA 标签、版本标签及主分支 `latest`。服务器使用 digest 固定版本，不自动追踪 `latest`。镜像只包含应用程序与静态页面，不包含课程、缓存或 SMB 配置。首次发布后需确保服务器具有 GHCR 拉取权限；私有包使用服务端已配置的只读 GHCR 凭据，不提交登录信息。

## 生产部署

使用已有 Docker Compose、Traefik `websecure` HTTPS 入口和外部 `traefik-net` 网络。项目目录为 `/opt/docker-compose/firstleap`。服务器安装 `cifs-utils`；应用容器不具有挂载权限。

1. 复制 `compose.yaml` 到项目目录；复制 `.env.example` 为服务器上的 `.env`，填入镜像 digest、站点主机名和独立挂载路径。`.env` 不进入 Git。
2. 创建项目下的 `data` 目录，将所有者设为 `10001:10001`。
3. 在服务器上以 root 运行 `deploy/install-mount.py`，从标准输入提供私有 JSON。字段为 `source`（`//server/share`）、`subdirectory`、`username`、`password`、可选 `domain`。由受信任的配置读取程序直接写入 stdin，不使用 shell 参数或输出凭据。脚本把凭据保存到 root-only 的 `/etc/firstleap/smb.credentials`，生成服务器专属 systemd 挂载单元，并将课程子目录只读挂载到 `/srv/firstleap/media`。真实 SMB 信息只保存在主机，不在 Compose 中。
4. 将 `deploy/firstleap.service` 安装到 `/etc/systemd/system/firstleap.service`。该单元在 Docker 和实际媒体挂载就绪后启动 Compose；`restart: on-failure` 处理容器进程故障，systemd 负责开机及 Docker 重启顺序。

```sh
cd /opt/docker-compose/firstleap
docker compose pull
sudo systemctl daemon-reload
sudo systemctl enable --now firstleap.service
docker compose ps
```

检查独立挂载为 `cifs` 且含 `ro`，容器 `/media` 为 `RW=false`。不要通过创建测试文件验证只读性。健康检查同时验证只读 CIFS 类型，防止错误绑定空目录。首次启动后台建立索引和缩略图，页面会逐步补全。

## 更新、停止与回滚

等待 GitHub Actions 发布成功，记录当前 `.env` 中的镜像 digest，然后将 `FIRSTLEAP_IMAGE` 改为新 digest：

```sh
cd /opt/docker-compose/firstleap
docker compose pull
sudo systemctl restart firstleap.service
docker compose ps
docker compose logs --tail=50
```

通过站点 HTTPS 检查 `/health/ready`、课程列表和视频首段/中段/末段。回滚时恢复之前的 digest 并重复 pull/restart。停止使用 `sudo systemctl stop firstleap.service`；重新启动使用 `sudo systemctl start firstleap.service`。只重启本项目，不重启共享 Docker 或 Traefik。

如 NAS 不可用，保留缓存和浏览器进度，恢复网络后重试；如挂载单元启动失败，在服务端私下检查其日志（可能包含共享地址），修复后启动挂载及应用单元。现有 NAS 目录和其它应用的挂载不受本项目管理。

## 使用边界

这是可信私有网络中的个人课堂，无账号，一个实例对应一位学习者；使用同一站点的设备共享学习档案和进度。课程内容来自部署者自己的媒体源。视频和派生缓存均排除在源码及镜像构建上下文之外。

## 课程讲解播放器

播放器使用 ArtPlayer 5.4.0，依赖随前端打包。画面内提供进度、播放／暂停、音量、网页全屏与全屏；快退 5 秒、快进 5 秒、更多跳转、连续播放和倍速位于音量左侧。窄屏时控制条分两行显示。其他步长收在“更多跳转”的快退、快进两列菜单中，跳转时显示短暂的方向和秒数反馈。

全屏按钮旁新增独立的“网页全屏”：视频铺满当前浏览器页面，保留浏览器窗口与标签栏，按 Esc 或再次点击即可退出。全屏与网页全屏均包含控制条和弹出菜单；菜单打开时，Esc 先关闭菜单。浏览器不支持原生全屏时自动使用网页全屏，退出或切课后恢复页面滚动。

播放器获得焦点后可使用空格播放／暂停、左右方向键跳转 5 秒，搜索输入不受影响。讲解视频提供 −30、−15、−10、−5、+5、+10、+15、+30 秒跳转。按钮在视频元数据就绪后可用，跳转不越过起止边界，并立即保存位置；暂停时操作保持暂停。

“美音朗读”Tab、视频接口、后台转码和专用挂载配置已移除。旧浏览器的朗读模式偏好会回到课程讲解；历史朗读进度及缓存保留在原位置，不再参与学习进度展示。更新部署时同步使用新的 Compose 与 systemd 文件，应用不再依赖朗读目录挂载。

## 四册课程与课文精听

“课程”入口独立于视频目录。四册分别为 72、96、60、48 个学习单元；第一册按 Lesson 1 & 2 等组合展示，使用奇数课号作为标识。每课含课文、生词、引导问题和参考译文，可下载现有 EPUB、PDF、AZW3、MOBI。第一册讲解页新增“课文精听”，与课程页面共用播放组件和进度。第二至四册讲解关联留有 TODO，导入课程源后再接入。

桌面与手机均使用“课文 / 单词”两个 Tab。切换 Tab 不打断播放，也不会自动切回课文；“回到当前句”主动切回并恢复跟随。每句英文下面独立折叠中文译文，默认收起，支持展开／收起全部。未补全逐句译文的旧教材仍可展开整课参考译文。

点击句子播放本句原音，点击单词播放其在当前句中的原音，单词 Tab 播放统一 `af_heart` 美音词音。“循环模式”提供关闭、整课循环、选中内容循环：整课从第一段正文的有效起点循环到最后一段正文的有效终点，读完立即按原倍速回到起点，跳过前奏与片尾；切换句子／段落断点模式不会改变循环范围。缺少有效正文时间时禁用整课循环，局部循环保留 0.5 秒间隔；点读退出整课循环，播放整课退出局部循环。暂停、切课和切换媒体会取消待执行的重播。上一句／下一句遍历课文句段。支持 0.5×–2× 且保持音调；空格暂停／继续，左右键切句，交互控件保留自己的键盘操作。

单词 Tab 默认展开“基础释义”，直接展示教材释义和本地 ECDICT 词典的中文释义、已有音标及词形，标明词典来源。ECDICT 音标以英式为主，不将单一音标标成同时具备英美读音。没有收录的单词或短语继续显示教材释义；基础释义无需配置 AI，也不会触发模型请求。现有美音播放继续使用已准备的词音。

“AI 拓展”默认收起，只有点击按钮才调用默认文字 Provider，完成后在词条内展开；基础释义在生成和失败时仍然可读。AI 参考教材材料和当前词典条目，补充按词性拆分的义项、说明、双语例句、可数性、动词变化、搭配及易混点，作为独立的 AI 内容显示。失败时点击“重试 AI 拓展”；收起后再次展开直接复用结果。打开课程或滚动词条不会自动调用 AI。

AI 拓展结果原子缓存于 `DATA_ROOT/ai/vocabulary`，按单词、教材词性和释义区分，跨设备及相同教材词条复用；刷新页面或服务重启后仍可通过按钮展开，已有旧版 AI 词条缓存也继续可用。缓存不会因为切换默认 Provider 而自动重做。服务器最多同时生成两个，重复请求共用后台任务；切换页面不删除已保存结果。缓存与其它 AI 数据一起备份。

播放、进度条、循环和倍速位于同一行。进度条显示句子或段落起点，并用“始”“终”分别标出正文开始和结束；完整断点列表也单独标注开始、结束和循环范围。密集起点可展开精确选择，结束标记始终单独显示；“句子起点 / 段落起点”和完整断点列表默认收在播放器设置中，每课分别保存选择。课文锚点、高亮和滚动跟随同一套断点，暂停时选择起点也会定位到对应的句子或段落。点击起点保持播放／暂停状态，返回完整音源并退出局部循环；暂停定位到末尾不会标记完成。滑块拖动先预览、松开后定位，避免反复加载音频。

书架和每册目录显示已学课数及完成进度。目录提供全部、未学、已学筛选，以及每课的播放位置；目录和课文标题区均可手动标记已学／未学。整课自然播放结束或循环播放到正文终点后自动标记已学，局部点读不会触发完成。手动修改状态不清除播放位置，不改变最近学习课程，也不会被后台播放保存覆盖。

### 基础词库

镜像构建自动下载固定版本的 [ECDICT](https://github.com/skywind3000/ECDICT)，校验 SHA-256 后转换成只读 JSONL 分片，随镜像保存于 `/app/dictionary/ecdict`。应用按需读取少量分片，不需要词典数据库服务，也不在启动或查词时下载数据。版本、来源与 MIT 许可保存在 `third_party/ecdict`，许可文件也随生成词库一起分发。

本地开发可提前准备词库（Python 3.11+，首次需下载约 63 MB）：

```sh
python3 tools/prepare_dictionary.py
# 默认输出 data/dictionary/ecdict；也可通过 --output 指定新目录。
# 已下载的固定版本可用 --source /path/to/ecdict.csv，仍会校验 SHA-256。
```

通过 `DICTIONARY_ROOT` 指定已生成的词库目录。本地未准备词库时仍可阅读教材释义与使用 AI 拓展。词库目录不可原地覆盖，更新快照时准备到新目录后再切换路径或发布新镜像；学习数据与 AI 缓存保存在原数据目录中。

### 准备教材

源目录保持原交付结构：`data/bookN.json`、`audio/bookN/index.json`、MP3 和根目录课程文件。`TEXTBOOK_ROOT` 只读；所有生成内容在 `DATA_ROOT/textbooks`，不进入源码或镜像。教材准备是部署前的离线步骤，网站不安装语音模型。

只生成阅读数据（无需额外 Python 包，可先启动网站）：

```sh
python3 tools/prepare_textbooks.py --source /absolute/path/to/textbooks --data ./data
TEXTBOOK_ROOT=/absolute/path/to/textbooks DATA_ROOT=./data go run ./cmd/firstleap
# 打开 http://localhost:8000/books
```

完整生成逐词时间与统一生词音频，推荐单独的 CPU Python 3.11 环境：

```sh
uv venv --python 3.11 .venv-textbooks
uv pip install --python .venv-textbooks/bin/python torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv-textbooks/bin/python whisperx==3.8.6 --no-deps
uv pip install --python .venv-textbooks/bin/python -r tools/requirements-textbooks.txt
# 设置 VIRTUAL_ENV 供首次安装英语分词资源使用。
VIRTUAL_ENV="$PWD/.venv-textbooks" .venv-textbooks/bin/python tools/prepare_textbooks.py --source /absolute/path/to/textbooks --data ./data --align --pronunciations
```

只使用 WhisperX 的强制对齐接口及 `facebook/wav2vec2-base-960h`，无需 ASR、说话人模型或 Hugging Face 私有令牌。首次运行会下载模型和英语分词资源；CPU 完整准备需要持续运行一段时间。通过 `HF_HOME`、`NLTK_DATA`、`UV_CACHE_DIR` 可将临时依赖与模型放到空间足够的位置。可先用 `--books 1 --lesson 1` 验证首课，再去掉限制处理四册。

生成按课原子写入，成功的课文和词音可断点复用；输入、修正或音频版本变化会重建对应课文。`--pronunciations-only` 从已有数据生成词音，不会改写正在对齐的课文。`--retry-partial` 重试缺词的对齐；`--threads 1` 可用于限制 CPU 线程。Linux 上可加 `--workers 2` 共享模型权重并行对齐；根据可用内存调整并发。

正文展示采用与教材顺序对应的朗读文字，保留教材的段落、人物标签及未朗读署名；录音和教材的文字差异输出到 `data/textbooks/library/reports`，不会修改原交付文件。第三册 Lesson 7 的重复句段在导入时处理；第一册 Lesson 55 排除误匹配的导读，Lesson 71 的句尾否定词使用经原音复核的时间修正。标题、问题等导读内容不作为正文导航目标。句子已有原始字幕边界，逐词边界由声学模型取得；缺少可靠时间的词保留文本，等待校订，不均分时长。`tools/textbook_overrides.json` 支持：

```json
{
  "lessons": {"1:1": {"bodyStart": 4, "sentences": {"4": "Excuse me!"}}},
  "timings": {"1:1": {"s4-w0": [15.11, 15.6]}},
  "pronunciations": {"word|n.": "phonemes"}
}
```

课号键为“册号:课号”，句子编号沿用原音时间轴的位置，单词 ID 按句内位置区分。修正后重新生成对应课文，检查异常报告及实际听感。第四册第 43 课的大数表达 `million million` 属于原音内容，保留其数学含义，不直接删除。

可选的 ONNX CPU 推理仍使用相同的 Kokoro v1.0 模型及音色：安装 `tools/requirements-textbooks-onnx.txt`，从 [Kokoro ONNX 模型发布页](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1) 获取未量化的 `kokoro-v1.0.onnx` 和 `voices-v1.0.bin`，在生成词音时追加 `--tts-onnx-model /path/kokoro-v1.0.onnx --tts-onnx-voices /path/voices-v1.0.bin`。独立进程可用 `--pronunciation-shard 0/2` 和 `1/2` 分担词库，各自复用已有输出。

### 服务、缓存与部署

新增接口：`GET /api/books`、`GET /api/books/{book}`、`GET /api/books/{book}/lessons/{lesson}`；整课音频后缀 `/audio`，句／词片段为 `/clips/{segmentId}`。词音为 `/api/pronunciations/{id}`，课程为 `/api/books/{book}/downloads/{format}`。音频、词音、片段和下载均支持 HEAD、Range、ETag 与条件请求。接口不会暴露主机路径。

片段只接受已登记的句／词 ID，后台最多同时生成两个；相同请求共用任务，结果原子写入 `DATA_ROOT/textbooks/clips`。缓存键包含音频文件版本、课文修订和片段边界。片段使用 PCM WAV，以自然结束事件控制复读，避免浏览器计时轮询导致越界。音频源失联时仍能读取已生成的课文，恢复后可直接重试。

已有生产部署可增加 `compose.textbooks.yaml` 叠加配置，并在服务器 `.env` 设置：

```dotenv
COMPOSE_FILE=compose.yaml:compose.textbooks.yaml
FIRSTLEAP_TEXTBOOK_PATH=/srv/firstleap/textbooks
```

将源资料放到该只读挂载目录，将离线生成的 `textbooks/library` 放到服务端 `data/textbooks/library`；确保容器用户 10001 可读，并可写 `data/textbooks/clips`。教材目录允许本地资源，不受视频专用 CIFS 检查约束。原 Compose 单独使用时仍可正常提供视频。

沿用现有 NAS 部署时，将完整原始教材目录复制到视频源 `NCESE01` 同级的 `NCESE01-textbooks`，在目标目录运行 `sha256sum --quiet -c MANIFEST.sha256` 核验复制结果。然后以 root 运行 `deploy/install-textbook-mount.py`：脚本从服务器现有视频挂载配置推导教材路径，复用私有凭据，创建 `/srv/firstleap/textbooks` 只读挂载，并为 `firstleap.service` 增加等待该挂载的配置。更新 Compose 配置、复制生成数据并验证权限后，再拉取新镜像和重启本服务。

更新前备份 `.env`、Compose 文件、systemd 配置并记录旧镜像 digest。保留源资料和整个数据目录即可更新／回滚应用，无需重新运行模型；回滚旧镜像时可以保留教材挂载和数据。需要释放片段缓存时可清理 `data/textbooks/clips`，之后按需重建；保留 `textbooks/library` 中的课文与词音。

精听进度位于 `firstleap.textbook.progress.v1`，按“册号:课号”保存整课位置、当前句、倍速、已学状态、断点类型及最近访问时间。旧版记录自动补齐默认字段，页面和同源浏览器标签页同步状态。点读与复读不会覆盖整课续听位置，不会自动把整课标记完成。视频、整课音频和点读播放互斥；手机后台行为遵循浏览器的媒体限制。

### 验证

```sh
python3 -m unittest discover -s tools -p 'test_*.py'
go vet ./...
go test -race ./...
pnpm test
pnpm build
pnpm test:e2e
```

完整准备后运行 `python3 tools/verify_textbooks.py --data ./data --decode`，核对 276 课、全部单词边界及生词音频解码；报告保存在 `data/textbooks/library/reports/validation.json`。

浏览器测试使用真实生成的音频验证自然结束复读、同词不同位置、倍速、高亮、续听、模式切换和手机布局。若本机尚未安装当前 Playwright 所需浏览器，先运行 `pnpm exec playwright install chromium`；也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已安装的 Chromium。


### 逐句译文的离线准备

句子详情新增可选 `translationZh`，原有整课 `translation`、句子 ID、逐词时间戳、音频修订号保持兼容。已经补全的数据位于 `data/textbooks/library/bookN/NNN.json`；部署新版时连同教材 library 一起同步到服务端，生成资料和模型继续排除在源码与镜像之外。

本次生成的 `data/textbooks/sentence-translations.tar.gz` 包含四册已补全的课程 manifest 与目录索引，包内路径从 `textbooks/library` 开始；部署时解压到服务端 `DATA_ROOT` 根目录即可。

逐句映射位于 `data/textbooks/translations/bookN/NNN.json`，格式如下。`text` 必须与对应句子完全相同；导入拒绝课号错误、漏句、空译文和过期英文，避免错位。可用 `--books`、`--lesson` 限定范围。

```json
{"book":1,"lesson":1,"sentences":{"s4":{"text":"Excuse me!","translationZh":"对不起。"}}}
```

```sh
# 只补全已有 manifest 的译文，无需源媒体、语音模型或重新对齐。
python3 tools/prepare_textbooks.py --data data --translations-only
python3 tools/verify_textbooks.py --data data --require-sentence-translations
```

普通教材准备会自动导入同一数据目录下的逐句映射；也可通过 `--translation-maps` 指定映射根目录。所有选中映射先校验，成功后逐课原子写入；更新译文不会改变词音缓存或原音片段边界。

可选的 `tools/align_textbook_translations.py` 使用 [multilingual MiniLM](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) 的本地 ONNX 模型，按原文顺序对齐现有中文分句。它是离线准备工具，网站不安装模型或调用翻译 API。安装 `tools/requirements-translations.txt`，把模型仓库的 `tokenizer.json`、`onnx/model_quint8_avx2.onnx` 放在数据目录下的独立模型文件夹，运行：

```sh
python3 tools/align_textbook_translations.py --data data --model data/textbooks/translation-model
```

生成后检查 `translations/review.json`，对低置信度映射及原资料漏译逐项补充或校订，再设置对应条目的 `reviewed: true` 并导入。再次运行会保留英文未变化的已校订条目；新教材仍需核对译文，不能把自动对齐结果直接视为人工审定。当前数据覆盖四册 276 课、4,264 个句段，并补充了原资料中的漏译及误译。


## AI 私人课堂

导航中的“课程”进入四册内容；课文页和课堂“课文精听”共用 AI 详解。桌面宽度至少 1024px 时左侧课文、右侧详解，手机通过“课程内容 / AI 详解”切换，切换不打断精听。

### 首次配置与使用

1. 打开 `/settings`，为文字模型填写包含 API 前缀的 Base URL 和 API Key，点击“获取模型列表”，再从服务商返回的模型中选择 Model。选择 Chat Completions 或 Responses，应用分别追加 `/chat/completions` 或 `/responses`。无需 Key 的本地服务可以留空。
2. 按需分别添加多个文字、生图和语音 Provider，并为每类选择默认服务。独立配置生图服务并启用配图，接口为 `/images/generations`。不同 Provider 的地址、Key 和 Model 完全独立。文字模型须支持所选协议的 function calling，模型通过 `generate_image` 工具自行决定是否配图。
3. 打开 `/learning-profile` 填写目标、薄弱项和口语／写作自评，或开始 16 题动态测评。测评包含词汇、语法、阅读、听力各 4 题，AI 根据之前的回答调整后续题目。听力复用现有可播放课程原音，无需额外语音服务；播放失败可重试或跳过，不记为答错。未完成的能力维度保留原档案。每道可作答题都额外提供“不知道”选项，无需猜答案；记录为明确的未掌握证据，用于后续出题与水平评估，与音频故障时不计分的跳过分开保存。
4. 打开课程后，有缓存直接显示；首次整课详解需要点击生成。每句的 AI 按钮、生词 AI 按钮，以及划选后出现的 AI 按钮，会查询对应缓存，未命中时生成。单击单词仍然点读，划选不触发播放。
5. 在“语音合成”中配置独立的 OpenAI 兼容、豆包 Seed TTS 或 Seed Audio 服务并开启自动生成。新详解完成后自动生成讲课稿和语音；旧详解在打开时补生成。首次生成可以先听已经完成的分段，生成完成后直接读取磁盘音频，不会自动出声。

### 多 Provider 与默认服务

文字、生图、语音分别以列表显示多个 Provider，列表展示名称、接口类型、模型或资源 ID、地址、密钥配置状态及默认标记。点击“编辑”在弹窗中修改单个 Provider；点击“添加 Provider”打开独立空白表单，名称、地址、密钥、模型、音色、风格和高级参数不继承已有服务。选择豆包原生接口后才填入该类型的官方地址及默认模型／资源 ID。每个 Provider 独立保存协议、超时及生成参数，语音还独立保存音色、语速、格式和高级参数。

弹窗中的“保存 Provider”只保存当前服务并立即生效，“取消”或关闭弹窗丢弃本次草稿。列表中的“设为默认”和确认删除也独立提交；新增服务不会自动成为默认。默认服务和每类最后一个服务不可删除。文字默认服务同时用于详解、测评、能力评估和语音讲课稿，生图与语音各使用自己的默认服务。生图开关、自动生成语音开关、工具与提示词由所有 Provider 共用，仍由“保存系统配置”统一保存；Provider 操作不会提交或覆盖这些未保存的修改。

已有单服务配置自动显示为“原文字服务 / 原生图服务 / 原语音服务”，并作为对应默认 Provider，地址、密钥和参数保留。Key 留空只保留当前 Provider 自己的 Key，清除选项也只作用于当前 Provider；修改地址后须重新填写或显式清除 Key；语音接口类型、鉴权方式或 App ID 改变时也适用。模型列表、连接测试和语音试听使用当前编辑的 Provider，不改变已保存的默认选择。读取接口不返回任何 Provider 的 Key。

配置接口的 `settings.providers` 包含 `text`、`image`、`tts` 三个列表，每项为 `{id, name, config}`，`defaults` 保存三类默认 Provider 的 ID。原有 `text`、`image`、`tts` 字段继续返回实际生效的默认配置，旧客户端省略 `providers` 时只更新默认服务并保留其它 Provider。模型列表、连接测试和语音试听请求可传 `providerId`，按该 Provider 复用已保存密钥；新增 Provider 不会继承其它服务的密钥。

切换默认服务不会清空已有详解、图片或语音缓存；需要更新已有内容时使用对应的重新生成功能。已开始的任务继续使用启动时的配置。

### AI 语音讲解

语音 Provider 可选择三种接口类型。旧配置未指定 `apiType` 时按 `openai` 处理，地址、密钥、生成参数和已有音频继续兼容。试听和正式生成使用相同适配器：原生请求与响应由适配器处理，分段、并发、超时、音频校验和缓存由公共流程管理。

- **OpenAI 兼容（`openai`）**：请求为 `POST {Base URL}/audio/speech`，Base URL 应包含 API 前缀，例如 `http://mac-studio:8001/v1`。填写服务商的 Model 和音色 Voice，可手动输入模型名称，获取模型列表不是必需条件。支持免 Key 的本地服务；Mac 上的 Qwen3-TTS、CosyVoice 需要先由支持该接口的推理服务提供 HTTP 接口。本应用负责接入，不在网站容器内安装语音模型。网站容器需要能访问语音服务，容器内的 `localhost` 指向容器自身。

- **豆包语音合成（`doubao-tts`）**：Base URL 默认 `https://openspeech.bytedance.com/api/v3`，调用 `/tts/unidirectional`。填写资源 ID（默认 `seed-tts-2.0`）和 Speaker 音色 ID；普通语音合成的 Model 可留空，使用复刻音色时按原生接口配置版本。音频按连续 JSON 记录返回，应用逐块解码 Base64 并要求完整结束状态。MP3 分块按顺序汇总；WAV 使用 PCM 汇总后封装为单个文件。讲课风格发送到 `additions.context_texts`；指定复刻 Model 时不可同时设置风格指令。
- **豆包音频生成（`doubao-audio`）**：同一 Base URL 下调用 `/tts/create`，默认模型 `seed-audio-1.0`。将分段讲稿与风格组成 `text_prompt`，要求保留原文、逐字朗读且不添加背景音乐和音效；填写音色后通过 `references[].speaker` 指定。读取响应中的 Base64 音频并缓存到本地，不依赖两小时后过期的上游链接。此功能用于现有讲解语音，不增加独立音频创作入口。

豆包默认使用新版控制台 API Key，通过 `X-Api-Key` 鉴权；选择旧版鉴权时填写 App ID，并在密钥栏填写 Access Token，发送 `X-Api-App-Id` 与 `X-Api-Access-Key`。Seed TTS 另发送 `X-Api-Resource-Id`；两种接口均生成独立 UUID 请求 ID。原生豆包接口不调用 `/models`，使用短句试听验证实际合成能力。

系统配置统一保存合成语速（默认 1.0，OpenAI 范围 0.25–4.0，豆包范围 0.5–2.0，映射为原生 `speech_rate`）、音色、MP3/WAV 格式（默认 MP3）、单段超时（默认 300 秒，范围 30–1800 秒）、可选的讲课风格和高级 JSON 参数。风格指令默认不发送，可选择标准 OpenAI 的 `instructions` 或 MLX 的 `instruct`，具体能力以服务商模型为准。高级参数可传语言、参考音频等扩展字段；参考音频须是 TTS 服务可识别的地址或服务端路径，不是浏览器本地路径。OpenAI 高级参数不能覆盖 `model`、`input`、`voice`、`speed`、`response_format`、指令或流式字段。豆包 Seed TTS 高级参数合并到 `req_params`，其中 `additions` 填写 JSON 对象，由应用序列化为原生字符串；Seed Audio 高级参数合并到请求顶层，Seed Audio 风格指令最多 2500 字符，为讲稿和固定提示词预留空间。两者都不能覆盖讲稿、模型、已配置音色、语速和格式，采样率等音频选项可放在 `audio_params`／`audio_config` 对象中。

“生成短句试听”使用当前设置草稿合成一段中英混合例句，无需先保存，会产生一次 TTS 调用；不会调用文字模型或保存试听音频。测试连接仍只检查模型列表，不代替真实试听。

讲课稿复用文字模型，依据已保存详解改写为口语化教学表达，保留知识点、英文例句和译文，去除不适合朗读的 Markdown、链接和图片路径。可在系统提示词中修改“语音讲课稿”并恢复默认。讲稿生成不调用教学工具；音频按句段拆分，每段最多 300 个 Unicode 字符，合成请求全局单并发，适合本地推理服务。每段独立超时，长语音任务不受文字任务十分钟总限制。

详解面板中的“听老师讲解”支持播放／暂停、已生成范围内拖动进度及 0.5×–2× 播放倍速。播放倍速只影响浏览器收听速度，不重新生成音频；播放器不提供音色或合成参数设置。播放倍速在浏览器记忆，暂不跨设备同步语音收听位置。AI 讲解与课文原音、视频共用播放互斥机制，避免声音重叠。

讲稿和分段音频保存到 `DATA_ROOT/ai/speech/`。音频校验后逐段原子写入，第一段就绪即可播放，播放赶上生成进度时等待下一段。生成失败保留已经完成的分段，点击“重试语音”继续；进程重启后，打开对应详解会继续未完成的生成。失败结果不会因轮询而不断重试扣费。正文内容改变后使用独立语音版本，避免同一详解重新生成后读出旧正文。

修改音色、语速或讲课风格不会删除已有语音，点击“重新生成语音”才采用新设置。只更换语音参数时复用已保存讲稿；修改讲稿提示词后重新生成会使用新讲稿。新版本完全生成成功前保留可播放的旧音频，正在收听的旧版本不会突然切换；旧版本没有可播放分段时，改用新版本，首段生成后即可收听。语音任务失败不影响详解文本。运行环境需安装 `ffprobe` 以校验音频和读取时长，现有 Docker 镜像已包含。

语音接口包括 `GET/POST /api/ai/explanations/{id}/speech`、`GET /api/ai/speech/{id}/segments/{index}` 和 `POST /api/settings/ai/tts/preview`。查询可带 `version`，生成请求须提供详解的 `contentVersion`，可选 `regenerate` 或 `retry`。生成返回语音状态、已保存分段和任务 ID，通过已有任务 SSE 获取进度；音频分段支持 HTTP Range 播放。设置中的 `tts` 独立保存密钥，读取配置只返回是否已配置。

单项 Provider 管理接口为 `POST /api/settings/ai/providers/{group}`（创建，提供独立 `id`、`name`、`config`）、`PUT/DELETE /api/settings/ai/providers/{group}/{id}`（修改／删除）和 `PUT /api/settings/ai/providers/{group}/default`（提供 `providerId`）。`PATCH /api/settings/ai` 仅修改 `enabledTools`、`prompts`、`imageEnabled`、`speechEnabled`；提示词支持按字段更新。单项操作在锁内与最新配置合并，原子持久化并返回脱敏的 `settings`。原有 GET/PUT 接口继续兼容旧客户端。GET 额外返回 `speechAdapters`，包含接口类型、显示名、模型列表能力、语速范围和空白默认模板。

AI 通过已启用的工具按需读取能力档案、目标、薄弱项、已学课程、当前课文位置和初学／复习状态。课文全文、档案、进度、测评记录和评估证据不再整块附加在首轮模型请求中；首轮只提供任务、必要标识和选中的词句。只有工具实际返回的数据才作为生成依据，详解界面的水平与初学／复习标记也仅展示实际读取过的依据。能力采用本应用五档教学等级，未经测评的口语和写作保留自评／未评估状态。课程播放完成只更新进度，不直接提升能力等级。

详解下方的“太难 / 合适 / 太简单”反馈会影响后续解释方式；可以注明词汇、语法、阅读或听力方面。每累计 3 条不同详解的新反馈，AI 自动重新评估能力，日常反馈的单项调整每次至多一档；测评结束会更新有完整测评记录的能力。学习档案可手动修改、固定单项能力、查看调整原因并恢复此前状态。首次未测评也可直接学习，AI 会标注水平未评估并提供基础解释。

### AI 工具

系统配置列出全部工具，可单独勾选、全选或取消全选，默认全部启用；老配置自动按全选兼容，保存空选择后重启仍保持全关。工具配置对新任务生效，后台仅向模型提供已勾选且适用于当前流程的工具，禁用工具即使被模型请求也会拒绝执行。

| 工具 | 内容 | 适用流程 |
| --- | --- | --- |
| `get_learner_profile` | 总体水平、六项能力、目标、薄弱项、讲解风格 | 详解、测评出题、能力评估 |
| `get_learning_progress` | 课文与讲解的已完成课程、数量和最近课程 | 详解、测评出题、能力评估 |
| `get_current_learning_state` | 当前课程、保存进度、播放位置、所在句、模式及初学／复习状态 | 详解 |
| `get_current_lesson` | 当前课程标题和完整英文课文 | 详解，整课详解必需 |
| `get_assessment_context` | 当前维度、历史作答、本题可用听力原音与文字 | 测评出题，必需 |
| `get_evaluation_evidence` | 本次评估的答题记录或反馈及关联讲解片段 | 测评结束与反馈触发的能力评估，必需 |
| `generate_image` | 教学配图，仍需独立启用和配置生图模型 | 详解 |

读取工具使用空参数 `{}`，后端绑定当前任务的一致数据快照，不接受模型指定其它课程或测评。档案和进度由 AI 按需选择；整课详解、出题和评估则必须成功读取各自的必要材料，工具关闭或模型未读取时明确报错，不静默回退到直接注入。词句详解可以只使用所选内容生成。答案、反馈和测评进度在失败后保留，重新启用必要工具即可继续。

Chat Completions 和 Responses 均支持上述多轮工具调用。每项任务最多执行 16 次工具调用，生图另外遵循独立次数上限；生图额度耗尽后仍可调用其它读取工具。结果记录实际成功调用的 `toolsUsed`。所有工具均不提供修改学习档案或进度的能力，模型输出仍由后端按既有证据、能力锁定和版本冲突规则校验后应用。

### 生成参数与缓存

系统配置支持通用、整课、句段、单词、测评、能力评估和生图风格提示词，并可逐项恢复默认。默认流式显示、输出上限 8192 tokens、文字单次超时 120 秒、生图 180 秒、整项任务最长 10 分钟。Temperature 默认不发送；Chat Completions 可切换 `max_completion_tokens` / `max_tokens` 字段。生图默认尺寸为 `1024x1024`，质量留空使用服务商默认值，详解默认最多调用生图 2 次，可设置 0–6 次。

文字与生图服务分别支持“获取模型列表”和“测试连接”，均使用当前表单配置，无需先保存。后端请求对应 Base URL 下的 `GET /models`（OpenAI 兼容的 `data[].id` 格式），复用相同地址已保存的 Key，返回模型列表、耗时和当前模型是否在列表中；不发起文字生成或生图，不验证推理、function calling 或生图能力。服务商须支持模型列表接口，并给 Key 相应的访问权限。模型不按名称推测类型过滤，按服务商能力选择文字或生图模型。修改地址或 Key 会清除旧列表；服务地址变化时需重新填写 Key，或显式清除旧 Key 后连接免 Key 服务，避免旧密钥被自动发送到其它地址。获取或测试不会保存草稿或改动已有配置。

详解缓存按课程原文、所选词句、影响讲解的能力档案、初学／复习阶段和启用工具集合区分。工具化版本使用独立缓存标识，旧版详解保留在历史记录中；改变工具选择后不会自动命中旧工具配置的结果。播放秒数变化、修改 Model、Key、提示词或参数不会使已有缓存自动失效。能力、目标、薄弱项或讲解方式变化后可生成新的个性化版本，并保留历史结果；图片按对应内容与提示词复用。

“按当前水平重新生成详解”采用最新配置；每张图片也可以独立重新生成。只有成功结果替换旧版本，失败时保留已有详解和图片。生图失败可重试图片，无需重新调用文字模型。相同内容的并发请求合并为一个后台任务，关闭页面后任务仍会完成并缓存；服务重启会终止未完成任务，已保存的结果继续可用。

### 进度、数据与备份

精听与讲解分别同步，完成状态与播放位置独立更新。播放期间每 5 秒同步；暂停、跳转、手动完成等操作保留在本地并同步，其他设备在打开、重新聚焦或周期刷新后读取。离线操作进入待同步队列，恢复连接后提交；过期字段更新不会覆盖服务端较新的记录。

首次同步导入现有浏览器记录，保留带 `.before-sync` 后缀的本地备份；服务端已有记录时优先使用服务端，补充缺失条目。原有 v1 进度格式继续作为本地缓存，更新或回滚不会改写课程源。

新增数据位于 `DATA_ROOT/ai`：`settings.json` 保存模型配置，`learner.json` 保存档案、反馈、测评及进度，`explanations/` 保存详解，`images/` 保存配图，`speech/` 保存讲课稿、语音索引与分段音频。配置和数据文件以受限权限原子写入。Key 只由后端请求使用，读取接口仅返回是否已配置；设置页留空保留原 Key，需要清除时勾选对应选项。Key 不进入浏览器持久存储和应用日志。

备份与镜像更新时保留整个 `DATA_ROOT`，其中 AI 配置文件含密钥。现有 Compose 已挂载可写 `/data`，无需新增挂载、数据库或环境变量。清除浏览器数据不会删除已同步到服务端的记录，但尚未同步的离线操作需要先恢复连接。

`GET /api/settings/ai` 返回 `settings.enabledTools`、默认配置与工具目录 `tools`；`PUT /api/settings/ai` 保存工具选择，省略该字段时保留现有选择，未知工具名返回 400。

主要新增接口为 `/api/settings/ai`、`POST /api/settings/ai/models`、`POST /api/settings/ai/test`、`/api/learner/profile`、`/api/learner/progress`、`/api/learner/feedback`、`/api/assessments`、`/api/ai/explanations`、`/api/ai/jobs/{id}/events` 和 `/api/ai/images/{id}`。配置与学习数据沿用个人课堂的访问范围。

自动化测试使用本地模拟模型服务，并启动实际 Go 服务验证设置、配图、缓存、划选、动态测评和跨设备进度，不消耗真实模型额度。接入真实服务商后，可先在一个课程的整课与词句详解中验证其协议和工具调用支持。
