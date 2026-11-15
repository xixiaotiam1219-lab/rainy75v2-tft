# AI 辅助定制与排错提示词

如果你想用 Codex、Claude Code、Cursor 等 Agent 工具，或者用网页版 ChatGPT / Claude / Gemini 来定制自己的固件和界面，千万不要只说一句“帮我写个能刷进 Rainy75 的固件”——AI 会瞎编内存地址或者把歌词功能塞进基础版。把本仓库对应文件提供给它，再套用下面的提示词，改出来的代码才能直接编、安全刷。

---

## 定制固件需要把什么传给 AI？

**先说最重要的一条：虽然仓库 `vendor/` 里放了 [Rainy75V2烧录工具20261112-1beta1.html](../vendor/Rainy75V2烧录工具20261112-1beta1.html)，但定制固件时千万不要把它、提取出的 `.bin`、`libISP585.a` 或字体 `.otf` 上传给聊天 AI。**
原因很实际：这份烧录 HTML 虽然网页界面 JS 可读，但整份文件约 **1.14 MB** 里绝大部分体积都是 `FIRMWARE` 对象中用 Base64 + 异或混淆编码后的**三份原厂二进制固件机器码**（键盘 `0x3F`、接收器 `0x26`、屏幕 `0x0002`）。AI 根本读不懂编码后的二进制机器码，不仅没法据此帮你修改固件行为，塞进对话还会白白撑爆上下文、误导 AI 去改烧录网页本身，而且内嵌的原厂固件二进制归 WOB 原厂所有（非 MIT 开源）。

你真正需要做的只是：本地用 `python tools/extract_stock.py "vendor/Rainy75V2烧录工具20261112-1beta1.html" --out inputs` 解出原厂 `.bin` 放在 `inputs/`，让 AI 只改下面的纯文本源码或 JSON 配置，改完后再由你（或本地 Agent）跑 `tools/build.py` 拼出最终固件。

AI 真正需要看的是**本仓库的纯文本源码、配置和文档**，具体分两种情况：

### 情况一：用本地 AI 编程工具（推荐：Cursor / Claude Code / Codex / Antigravity）

- **要给什么**：直接把本仓库克隆到本地，用 AI 工具打开项目目录即可；在要求定制固件或界面时，提醒它**不要读取 `vendor/*.html` 里的大段编码固件，也不要去改 `vendor/`**（直接改 `profiles/`、`firmware/`、`web/`、`desktop/`）。
- **如果想让 AI 顺便帮你编译出可刷入的 `.bin`**：只需你提前在本地跑一次 `tools/extract_stock.py`，再把 `inputs/libISP585.a` 放好并装上 Clang（AI 会直接调用 `tools/build.py` 构建，不会把 `inputs/` 上传到 Git）。

### 情况二：用网页版聊天 AI（ChatGPT / Claude / Gemini 等上传文件对话）

- **打包上传时记得剔除 `vendor/`**：如果去 GitHub 点 `Code → Download ZIP` 下载整个仓库，记得**先删掉里面的 `vendor/` 目录**（以及本地生成的 `inputs/`、`build/`），把剩下的纯源码打成压缩包（只有几百 KB）再传给 AI；不然 `1.14 MB` 的烧录 HTML 会把附件体积和对话上下文占掉一大半。
- **如果平台限制附件数量，按你想改的内容挑下面这几个文件传就行**：

| 你想让 AI 帮你改什么 | 必须传给 AI 的仓库文件 | 你还需要额外提供的材料 | 拿到 AI 结果后怎么做 |
| --- | --- | --- | --- |
| **只改配色 / 改大按键图标** | `profiles/themes.json`、`profiles/keys.json`、`profiles/font.json`、`tools/assets.py`、`docs/customization.md` | 想要的配色风格或参考图、想增改的按键 | 把 AI 改好的 `.json` 放回本地，自己跑 `build.py` 编译烧录 |
| **换成自己的 GIF 角色动画** | `profiles/themes.json`、`tools/assets.py`、`docs/customization.md` | 你自己的图片 / GIF 源文件，并说明是否装了歌词版 | 让 AI 裁成 `320×172`（歌词版需满足全帧和 `(22,39)` 标记像素），在网页工作台上传到 S1 |
| **改基础版画面排版 / 新增状态** | 上面全部 + `README.md`、`AGENTS.md`、`firmware/ips/*`、`firmware/main/*`、`tools/build.py`、`docs/protocol.md`、`docs/compatibility.md` | 你想要的布局草图、数据来源说明 | 替换本地源码后运行 `build.py` 和测试，确认无报错再烧录 |
| **改歌词版布局 / 控制台 / 匹配规则** | 上面全部 + `firmware/ips-lyrics/*`、`desktop/*`、`tools/fontpack.py`、`docs/lyrics.md` | 使用的播放器（QQ / 网易云）与具体需求 | 替换源码后跑 `npm test`，需要时重新编译歌词版 IPS |

> 除了文件，发提示词时还一定要用文字交代清楚三件事：① 你要改的是**基础屏幕版**还是**歌词扩展**；② **不要让 AI 把你的原厂 `.bin`、个人设备号、本地路径或私人图片写进可公开提交的内容**；③ 网页版 AI 改完代码后无法替你实机验证，务必先自己跑一遍 `unittest` / `npm test` 和 `build.py` 的边界检查再刷入键盘。

---

## 先按需求选模板

| 你想做什么 | 复制下面哪段提示词 | 涉及主要目录 |
| --- | --- | --- |
| 改大图标、换机器人或调配色 | [基础版改图标与主题](#基础版改图标与主题) | `profiles/`、`tools/assets.py`、`firmware/ips/` |
| 改歌词页布局、字体大小或控制台 | [歌词版改布局与控制台](#歌词版改布局与控制台) | `firmware/ips-lyrics/`、`desktop/`、`tools/fontpack.py` |
| 调整 20/40px 布局或更换字库 | [歌词版调整字号与更换字库](#歌词版调整字号与更换字库) | `firmware/ips-lyrics/`、`web/hid.mjs`、`R75F/2` 校验 |
| 歌词搜不到、错版或老是对不准 | [歌词版排查来源与延迟](#歌词版排查来源与延迟) | `desktop/music.cjs`、`lyric-provider.cjs`、`netease-timeline.cjs` |
| 时钟显示横线、对时报错或显示错位 | [排查显示或校时异常](#排查显示或校时异常) | `firmware/main/`、`firmware/ips/`、`web/hid.mjs` |
| 在屏幕上加一个新的状态图标/文字 | [新增一个状态显示字段](#新增一个状态显示字段) | `firmware/ips/`、`firmware/main/`、`web/protocol.mjs` |
| 把这套思路搬到另一块带屏外设上 | [迁移思路到其他外设](#迁移思路到其他外设) | 参考架构设计 |
| 自己二开完了想整理开源 | [整理分支准备开源](#整理分支准备开源) | 全局检查与文档更新 |

---

## 基础版改图标与主题

```text
请先阅读 README.md、AGENTS.md、docs/customization.md 和 docs/compatibility.md。

我要修改的是「基础屏幕版」，不要给我引入字库、歌词固件或 Windows 后台。
我的目标：设计并制作一套【填写你的配色和风格需求】主题，保留时钟、电量、连接图标和大单键显示；角色动画保留默认机器人（或使用我提供的【说明素材路径】）。

要求：
1. 检查 profiles/keys.json、profiles/themes.json 和 tools/assets.py；
2. 修改点阵与主题配置后，生成 320×172 的软件预览图给我看（如果有实机要求再告诉我怎么编）；
3. 大图标按可见像素居中，核对左右 Win、Enter、方向键和 PgUp/PgDn；
4. 先修改源码、生成预览并跑通适用测试（unittest / npm test / check_release.py），不要擅自连键盘烧录或写设备。
```

## 歌词版改布局与控制台

```text
请先阅读 README.md、AGENTS.md、docs/lyrics.md、docs/protocol.md 和 docs/compatibility.md。

我要修改的是「歌词播放器扩展」，具体想改：【描述布局、颜色、字体或控制台需求】。
当前设备状态：【已装基础 IPS / 已装歌词版 LY1 / 未知】；电脑系统：【Windows 版本】。

要求：
1. 检查 firmware/ips-lyrics、desktop、tools/build.py 和 tools/fontpack.py；
2. 保留按键机器人页、`Ctrl+F8` 切换和现有基础功能，尽量把改动收敛在歌词扩展目录里；
3. 维持“静态字库与动画留设备 + 换句只传字形编号与计时”的设计，保留 96 字上限、独立标题滚动和单轮最多 4 次读取的 GUI 限制，不要在回调里做文件 I/O，也不要改动播放器真实播放状态；
4. 完成后先交付改动说明、软件预览图和自动化测试结果（unittest / npm test）；如果我本地 inputs/ 齐备且我明确同意构建，再检查 ROM/RAM 边界和 Unicorn 模型测试；不要擅自刷机。
```

## 歌词版调整字号与更换字库

```text
我需要调整歌词字号布局或更换屏内字库。请先读 docs/lyrics.md 的「更换已有字库」、docs/protocol.md 的 OP26/27 与 OP22 字段 8–10，再检查源码和测试。

要求：
1. 保留 20px / 40px 共用同一份 R75F/2 字库的结构，40px 在屏幕内按 2 倍整数绘制，不要额外多生成一套 40px 字库文件；
2. 如果要替换字体，先核对字符覆盖、大小与字体许可证，提醒我保留当前 FONT.BIN 和恢复包；
3. 保持安全替换边界：只允许删固定 FONT.BIN，必须先校验旧字库头部与大小、在暂停后且 GUI/DMA 空闲时执行、轮询真正完成后才上传新字库，不能改成自动删除其他素材或删掉 CRC 校验；
4. 如实说明替换过程中断并非原子操作，先给源码改动、预览和单测/模型验证结果，不要擅自连接硬件或推送。
```

## 歌词版排查来源与延迟

```text
请先阅读 docs/lyrics.md、docs/protocol.md 和 docs/validation.md。

我遇到的问题是：【暂无歌词 / 匹配到错的版本 / 歌词明显快或慢了 N 秒 / 换句卡顿】。
播放器与版本：【QQ 音乐 / 网易云音乐，版本号】；连接方式：USB 有线。

请按下面链路帮我定位：
1. 电脑端读取到的媒体元数据（标题、歌手、专辑、时长）；
2. 歌词平台检索和版本/时长筛选规则；
3. 播放进度来源（Windows SMTC 还是网易云 Elog 重建的 positionMs）；
4. 歌词偏移 offset 与屏幕 committed revision 的提交耗时。

不要用假进度从 0 开始硬计时，也不要直接删掉版本过滤。先写一个最小脱敏测试复现问题并定位根因，优先在 desktop/ 端解决，修复后跑通 npm test 再告诉我结果。
```

## 排查显示或校时异常

```text
请先阅读 docs/usage.md、docs/compatibility.md、docs/protocol.md 和 docs/recovery.md。

问题现象：【具体描述】；连接方式：【USB / 2.4G / 蓝牙】；
当前固件版本：【描述已知情况】；出现前做过什么操作：【刚刷机 / 切模式 / 休眠唤醒 / 断过开关】。

请按“电脑下发 → 主控 RTC 与 0x49000 记录页 → 主控推给屏幕的快照 → 屏幕本地秒数插值 → 内存叠画”这条链路逐段分析源码，给出对应文件名和函数证据。不要瞎猜空闲 RAM 地址或强刷按键，如果必须连接实机读取只读状态，先列出你想查什么、确认我同意后再执行。
```

## 新增一个状态显示字段

```text
我想在屏幕上加一个新状态显示：【描述要显示什么】。
请先阅读 firmware/ips/、firmware/main/、web/protocol.mjs 和 docs/protocol.md。

要求：
1. 先分析数据从哪来：键盘主控有没有原生通知，还是必须依赖电脑后台推？何时失效或清空？
2. 沿用本地缓存动画 + 少量字段叠加的设计，别破坏现有 1378 字节的 mask 边界；
3. 核对报文长度、校验、RAM/ROM 边界以及 LCD DMA 忙标志，绝不在中断里阻塞绘图；
4. 不要移除原厂输入校验或地址边界检查。先写出可离线单测的解析和渲染代码，标明哪些通过了仿真/单测、哪些需要我上实机确认。
```

## 迁移思路到其他外设

```text
我的目标设备是：【型号】；屏幕/主控信息：【已知型号或未知】；我手头的资料：【官方 SDK / 抓包 / 源码】。

我想借鉴 rainy75v2-tft「静态动画留设备 + 少量状态快照叠画」的思路实现【具体玩法】。
不要直接套用 Rainy75 的 Flash 绝对地址、USB PID 或协议字节。请先帮我拆解：
1. 哪些主机端逻辑（如状态桥、WebHID、字库生成）可以直接借鉴；
2. 哪些设备端驱动和内存布局必须针对新芯片重新梳理，还缺什么硬件信息；
3. 给出一个最小通信协议草案、状态超时失效机制、内存与带宽估算，以及先用模拟器或开发板验证的步骤。
```

## 整理分支准备开源

```text
请先阅读 LICENSE、DISCLAIMER.md、THIRD_PARTY_NOTICES.md 和 CONTRIBUTING.md。
帮我检查当前分支准备提交的内容：
1. 确认没有把 inputs/ 里解出的 .bin、libISP585.a、build/ 产物、个人设备标识、Elog 日志、本地绝对路径或私人角色图放进 Git 暂存区，也不要改动 vendor/ 里的原厂随仓烧录文件；
2. 确认保留了原作者 LICENSE 署名、字体 OFL-1.1 声明、Elog 上游 MIT 声明以及 vendor/ 的非 MIT 版权边界说明；
3. 同步更新 README 和相关文档里的截图、版本状态和已知限制，不虚构未跑过的实机测试；
4. 跑完 python -m unittest、npm test 和 python tools/check_release.py 并把结果列出来，等我确认后再推远程。
```

---

## 怎么判断 AI 改得靠不靠谱？

硬件相关的改动最怕 AI“看着顺眼其实瞎编”。让它干完活后，重点盯三件事：

1. **有没有拿出实打实的文件路径、构建边界检查和单测结果**（而不是笼统说“理论上同型号芯片都能用”）；
2. **有没有分清“代码编过”、“模拟器跑通”和“真键盘上亮了”这几层概念**；
3. **遇到未知项时有没有老实说不知道**，而不是靠删掉 `build.py` 里的校验或者硬凑地址来骗自己“编译成功”。
