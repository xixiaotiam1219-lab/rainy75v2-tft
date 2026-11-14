# 第三方与素材说明

## MIT 的范围

根目录 `LICENSE` 的 MIT 文本及原有作者署名保持不变。仓库自写的补丁逻辑、协议工具、生成器、文档及原创机器人图形按该许可提供。

点阵字形以可编辑的二进制单元格存放于 `profiles/font.json` 和 `profiles/keys.json`，不包含字体软件文件、系统字体、厂商字库导出文件或外部角色图包。默认机器人由 `tools/assets.py` 中的几何绘制代码生成；预览图与 GIF 由同一生成器创建。

## 可选歌词字库：SIL OFL-1.1

`tools/fontpack.py` 可从使用者本机提供的 **Noto Sans CJK SC** 生成 Rainy Lyrics Pixel 20 字模包。源字体版权信息：© 2014–2021 Adobe (http://www.adobe.com/)。来源为 [Noto CJK](https://github.com/notofonts/noto-cjk)，字体及衍生字库适用 [SIL OFL-1.1 完整文本](licenses/OFL-1.1.txt)。仓库不打包源 OTF 或完整 FONT.BIN。

生成器随字库输出版权说明和 OFL。再分发字体或其衍生版本时应附带这些声明，遵守保留名称、字体不得单独售卖及衍生字体许可等条件；根目录 MIT 不重新许可字体。README 的歌词渲染预览使用该字体，图片中的机器人和示例文字由本项目制作。

## 网易云 Elog 适配：上游 MIT

`desktop/netease-timeline.cjs` 的字节映射与事件结构参考以下 MIT 项目，并保留 [完整版权与 MIT 声明](licenses/netease-elog-MIT.txt)：

- [Coooookies/netease-cloudmusic-detector](https://github.com/Coooookies/netease-cloudmusic-detector)：Copyright (c) 2025 ButterCookies。
- [dsh-pet-qqmusic 的 Elog 适配与第三方说明](https://github.com/344272586-sketch/dsh-pet-qqmusic/blob/main/THIRD_PARTY_NOTICES.md)：Copyright (c) 2026 YouRan；Copyright (c) 2026 dsh-pet-qqmusic contributors。

本项目按当前曲目与进度需求重新组织有界读取，不打包用户日志或播放器文件。QQ / 网易云曲名、歌词与服务的权利仍属相应权利人，代码 MIT 许可不授予歌词内容再分发权。公开测试与预览使用人工示例和模拟接口，不打包实际歌曲歌词缓存。

## 不包含且未重新许可的内容

- WOB 原厂主控、接收器、IPS 固件及原厂烧录 HTML 模板。
- 从厂商网页提取的客户端代码。
- WCH `libISP585.a`、其生成的机器码 blob、厂商 SDK 源码或手册副本。
- 个人角色动画、由其衍生的图片、宠物标识、设备标识和校时日志。

构建器只接受用户本机提供的匹配文件。构建产物同时含有原厂与 SDK 内容，**不能仅因使用本项目构建就把完整镜像重新声明为 MIT**。如需再分发该类产物，应另行取得相应权利并遵守对应许可。

## 本地依赖

| 依赖 | 用途 | 许可说明 |
| --- | --- | --- |
| Python | 本地生成与构建脚本 | 由 Python 项目自身许可约束 |
| Pillow | 生成原创 PNG / GIF | HPND / Pillow 自身许可；不随仓库打包依赖代码 |
| LLVM / Clang / LLD | ARM 与 RISC-V 编译链接 | Apache-2.0 WITH LLVM-exception 等上游许可；不打包工具链 |
| Node.js | 运行可选协议测试 | Node.js 自身许可；网页运行不依赖 Node 服务 |
| node-hid 3.4.0 | 可选 Windows 歌词后台访问指定 USB HID | MIT 及包中原生依赖各自许可；通过 npm 安装，不打包运行时或原生二进制 |
| fontTools | 可选字库生成时读取 cmap 与字体元数据 | MIT；通过 Python 安装，不打包依赖源码 |
| Playwright | 可选无头浏览器界面测试 | Apache-2.0；自行安装，不打包浏览器或运行时 |
| Unicorn | 可选本地ARM指令模型 | GPL-2.0等上游许可，以对应发行包为准；仅本机测试依赖，不打包模拟器二进制 |
| WCH ISP 库 | 用户本地构建主控 Flash 操作代码 | 未纳入 MIT；请检查取得该 SDK 时附带的许可及芯片使用限制 |

外部参考：

- [WCH CH585 官方 SDK 仓库](https://github.com/openwch/ch585)，本项目兼容库版本来自 commit `db889195f07b8f3f4e7bf2c55f96a35daa14bebf`。
- [Artery AT32F435 产品说明](https://www.arterytek.com/en/product/AT32F435.jsp)。
- [WOB 网页驱动](https://wobwxe.com/)。

以上名称、链接与兼容性参数用于识别与说明，不表示官方背书，不改变各自的权利归属。
