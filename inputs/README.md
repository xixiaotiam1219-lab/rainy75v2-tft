# 本地输入文件目录

这个目录用来放本地编译固件所需的第三方原厂输入文件。除本说明外，`.gitignore` 已自动屏蔽该目录下的所有文件，不用担心误提交。

你需要自行准备并放入以下文件（具体获取方式与 SHA-256 校验值请看 [本地构建指南](../docs/build.md)）：

- `ips-stock.bin` — 原厂屏幕固件（可用 `tools/extract_stock.py` 从官方烧录 HTML 提取）
- `main-stock.bin` — 原厂键盘主控固件（同上）
- `libISP585.a` — WCH CH585 官方 SDK 的 Flash 操作静态库（编译主控固件时需要）
- `NotoSansCJKsc-Regular.otf` — 思源黑体（只有启用可选歌词扩展生成 `FONT.BIN` 时才需要）
