# FirstLeap

一个安静、专注的个人英语课堂。支持新概念英语第一册讲解／朗读视频，以及四册课程、原音逐句逐词点读、循环精听、生词美音和同步高亮。

React + TypeScript + Vite 前端，shadcn/ui（Radix）+ Tailwind CSS v4 组件与样式，Go HTTP 服务，单一 Docker 镜像。Go 直接流式读取只读媒体目录，支持 Range、HEAD、条件请求；原始 H.264/AAC MP4 不转码。`ffprobe` 和 `ffmpeg` 用于元数据、缩略图与朗读视频兼容副本；讲解原视频不转码。无账号、无数据库。课程、讲解和朗读进度同步到服务端，浏览器保留本地缓存与离线待同步记录；电脑和手机共用一个学习档案。

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

## 美音朗读视频

每节正式课程提供“课程讲解 / 美音朗读”切换，分别保存播放位置与完成状态。首页完成率仍按讲解统计；朗读进度使用独立的 `firstleap.reading.progress.v1` 浏览器存储。初次默认讲解，之后记住视频类型。导学课无朗读；缺失课文明确提示，连续播放在缺失处停止。

朗读源通过 `READING_ROOT` 配置（本地开发可省略，生产 Compose 为 `/readings`）。文件名采用 `新概念第一册美音版第01集.mp4`，只接收 1–143 的奇数课号，按课号关联讲解而不是文件排序。同课号重复文件会报告处理失败，不随意取一个。添加文件后最长约 5 分钟重新发现；源恢复后提前重新扫描。

新增接口 `GET/HEAD /api/lessons/{id}/reading/video` 支持 Range、ETag 和 If-Range；现有课程响应的 `reading` 包含稳定 ID、课号、时长与 `ready/processing/missing/error/unavailable` 状态。导学课没有 `reading`。未配置或源故障时朗读单独显示不可用，不影响讲解就绪检查。

原始朗读文件保持只读。后台单任务队列转为原分辨率 H.264、yuv420p、CRF 20、AAC 音轨复制及 faststart MP4，供手机与电脑播放；派生文件及目录缓存在 `DATA_ROOT/readings`。按源文件路径、大小、修改时间和转码版本复用缓存，转换完成后原子替换，失败在下一次扫描重试。首次准备期间可正常观看讲解。缓存不进入镜像或 Git；备份、更新与回滚时保留整个数据目录。

在既有部署上，以 root 执行 `deploy/install-reading-mount.py`。脚本只在服务器读取已有私有 mount 配置，从课程源推导对应的 `-video` 同级目录并复用凭据，不输出共享地址。生成 `/srv/firstleap/readings` 的独立只读 CIFS 挂载。为服务器 `.env` 增加 `FIRSTLEAP_READING_PATH=/srv/firstleap/readings`，更新 Compose 和 systemd 服务文件；服务会等待两个真实挂载，再创建容器。未挂载时不会创建空宿主目录代替媒体源。

等待 Actions 发布后使用新镜像 digest 部署。检查 `reading.status` 全部就绪、缺失课号提示正确，并实测首、中、末朗读视频。回滚时恢复旧镜像 digest；新增只读挂载及缓存可以保留。不要修改源文件来测试故障，使用测试目录或隔离的预览实例验证。

### 播放器快捷操作

播放器使用 ArtPlayer 5.4.0，依赖随前端打包。画面内提供进度、播放／暂停、音量与全屏；快退 5 秒、快进 5 秒、更多跳转、朗读循环、连续播放和倍速统一放在音量左侧，不再显示下方独立工具栏。窄屏时控制条在画面内分两行显示。其他步长收在“更多跳转”的快退、快进两列菜单中；跳转时显示短暂的方向和秒数反馈。倍速菜单、朗读循环与连续播放使用 shadcn 控件，全屏包含控制条和弹出菜单；不支持容器全屏的浏览器使用网页全屏。

播放器获得焦点后可使用空格播放／暂停、左右方向键跳转 5 秒；搜索输入不受影响。保留原有浏览器进度格式，关闭播放器库自己的进度恢复与循环，避免覆盖学习记录。测试覆盖真实生成的 H.264/AAC 视频解码、拖动、自然结束循环、实例清理和全屏回退；实际课程源另做上线验收。

讲解视频提供 −30、−15、−10、−5、+5、+10、+15、+30 秒跳转，朗读提供 −10、−5、+5、+10 秒跳转。按钮在视频元数据就绪后可用，跳转不越过起止边界，并立即保存位置；暂停时操作保持暂停。手机与桌面使用一致的主控制组，更多步长在菜单内选择。

朗读的“循环当前视频”默认关闭，偏好保存在 `firstleap.reading.loop.v1`。播放结束后保留完成状态，从头按当前倍速继续；与连续播放互斥。切换到讲解时不应用循环，返回朗读时恢复偏好。浏览器阻止自动重播时可手动继续播放。

## 四册课程与课文精听

“课程”入口独立于视频目录。四册分别为 72、96、60、48 个学习单元；第一册按 Lesson 1 & 2 等组合展示，使用奇数课号作为标识。每课含课文、生词、引导问题和参考译文，可下载现有 EPUB、PDF、AZW3、MOBI。第一册讲解页新增“课文精听”，与课程页面共用播放组件和进度。第二至四册讲解关联留有 TODO，导入课程源后再接入。

桌面与手机均使用“课文 / 单词”两个 Tab。切换 Tab 不打断播放，也不会自动切回课文；“回到当前句”主动切回并恢复跟随。每句英文下面独立折叠中文译文，默认收起，支持展开／收起全部。未补全逐句译文的旧教材仍可展开整课参考译文。

点击句子播放本句原音，点击单词播放其在当前句中的原音，单词 Tab 播放统一 `af_heart` 美音词音。“循环模式”提供关闭、整课循环、选中内容循环：整课自然结束后从 0 秒按原倍速继续，局部循环保留 0.5 秒间隔；点读退出整课循环，播放整课退出局部循环。暂停、切课和切换媒体会取消待执行的重播。上一句／下一句遍历课文句段。支持 0.5×–2× 且保持音调；空格暂停／继续，左右键切句，交互控件保留自己的键盘操作。

播放、进度条、循环和倍速位于同一行。进度条仅标记起点，密集点可展开精确选择；“句子起点 / 段落起点”和完整断点列表默认收在播放器设置中，每课分别保存选择。课文锚点、高亮和滚动跟随同一套断点，暂停时选择起点也会定位到对应的句子或段落。点击起点保持播放／暂停状态，返回完整音源并退出局部循环；暂停定位到末尾不会标记完成。滑块拖动先预览、松开后定位，避免反复加载音频。

书架和每册目录显示已学课数及完成进度。目录提供全部、未学、已学筛选，以及每课的播放位置；目录和课文标题区均可手动标记已学／未学。整课自然播放结束自动标记已学，局部点读不会触发完成。手动修改状态不清除播放位置，不改变最近学习课程，也不会被后台播放保存覆盖。

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
2. 按需独立配置生图服务并启用配图，接口为 `/images/generations`。两个模型的地址、Key 和 Model 完全独立。文字模型须支持所选协议的 function calling，模型通过 `generate_image` 工具自行决定是否配图。
3. 打开 `/learning-profile` 填写目标、薄弱项和口语／写作自评，或开始 16 题动态测评。测评包含词汇、语法、阅读、听力各 4 题，AI 根据之前的回答调整后续题目。听力复用现有可播放课程原音，无需额外语音服务；播放失败可重试或跳过，不记为答错。未完成的能力维度保留原档案。每道可作答题都额外提供“不知道”选项，无需猜答案；记录为明确的未掌握证据，用于后续出题与水平评估，与音频故障时不计分的跳过分开保存。
4. 打开课程后，有缓存直接显示；首次整课详解需要点击生成。每句的 AI 按钮、生词 AI 按钮，以及划选后出现的 AI 按钮，会查询对应缓存，未命中时生成。单击单词仍然点读，划选不触发播放。

AI 通过已启用的工具按需读取能力档案、目标、薄弱项、已学课程、当前课文位置和初学／复习状态。课文全文、档案、进度、测评记录和评估证据不再整块附加在首轮模型请求中；首轮只提供任务、必要标识和选中的词句。只有工具实际返回的数据才作为生成依据，详解界面的水平与初学／复习标记也仅展示实际读取过的依据。能力采用本应用五档教学等级，未经测评的口语和写作保留自评／未评估状态。课程播放完成只更新进度，不直接提升能力等级。

详解下方的“太难 / 合适 / 太简单”反馈会影响后续解释方式；可以注明词汇、语法、阅读或听力方面。每累计 3 条不同详解的新反馈，AI 自动重新评估能力，日常反馈的单项调整每次至多一档；测评结束会更新有完整测评记录的能力。学习档案可手动修改、固定单项能力、查看调整原因并恢复此前状态。首次未测评也可直接学习，AI 会标注水平未评估并提供基础解释。

### AI 工具

系统配置列出全部工具，可单独勾选、全选或取消全选，默认全部启用；老配置自动按全选兼容，保存空选择后重启仍保持全关。工具配置对新任务生效，后台仅向模型提供已勾选且适用于当前流程的工具，禁用工具即使被模型请求也会拒绝执行。

| 工具 | 内容 | 适用流程 |
| --- | --- | --- |
| `get_learner_profile` | 总体水平、六项能力、目标、薄弱项、讲解风格 | 详解、测评出题、能力评估 |
| `get_learning_progress` | 课文、讲解、朗读的已完成课程、数量和最近课程 | 详解、测评出题、能力评估 |
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

精听、讲解和朗读分别同步，完成状态与播放位置独立更新。播放期间每 5 秒同步；暂停、跳转、手动完成等操作保留在本地并同步，其他设备在打开、重新聚焦或周期刷新后读取。离线操作进入待同步队列，恢复连接后提交；过期字段更新不会覆盖服务端较新的记录。

首次同步导入现有浏览器记录，保留带 `.before-sync` 后缀的本地备份；服务端已有记录时优先使用服务端，补充缺失条目。原有三个 v1 进度格式继续作为本地缓存，更新或回滚不会改写课程源。

新增数据位于 `DATA_ROOT/ai`：`settings.json` 保存模型配置，`learner.json` 保存档案、反馈、测评及进度，`explanations/` 保存详解，`images/` 保存配图。配置和数据文件以受限权限原子写入。Key 只由后端请求使用，读取接口仅返回是否已配置；设置页留空保留原 Key，需要清除时勾选对应选项。Key 不进入浏览器持久存储和应用日志。

备份与镜像更新时保留整个 `DATA_ROOT`，其中 AI 配置文件含密钥。现有 Compose 已挂载可写 `/data`，无需新增挂载、数据库或环境变量。清除浏览器数据不会删除已同步到服务端的记录，但尚未同步的离线操作需要先恢复连接。

`GET /api/settings/ai` 返回 `settings.enabledTools`、默认配置与工具目录 `tools`；`PUT /api/settings/ai` 保存工具选择，省略该字段时保留现有选择，未知工具名返回 400。

主要新增接口为 `/api/settings/ai`、`POST /api/settings/ai/models`、`POST /api/settings/ai/test`、`/api/learner/profile`、`/api/learner/progress`、`/api/learner/feedback`、`/api/assessments`、`/api/ai/explanations`、`/api/ai/jobs/{id}/events` 和 `/api/ai/images/{id}`。配置与学习数据沿用个人课堂的访问范围。

自动化测试使用本地模拟模型服务，并启动实际 Go 服务验证设置、配图、缓存、划选、动态测评和跨设备进度，不消耗真实模型额度。接入真实服务商后，可先在一个课程的整课与词句详解中验证其协议和工具调用支持。
