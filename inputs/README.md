# 本地输入文件目录

这个目录用来放本地编译固件所需的第三方原厂输入文件。除本说明外，`.gitignore` 已自动屏蔽该目录下的所有文件，不用担心误提交。

你可以从仓库自带的 [vendor/Rainy75V2烧录工具20261112-1beta1.html](../vendor/Rainy75V2烧录工具20261112-1beta1.html) 直接解出原厂固件，其余依赖按 [本地构建指南](../docs/build.md) 补齐即可：

- `ips-stock.bin` — 原厂屏幕固件 `0x0002`（运行 `python tools/extract_stock.py "vendor/Rainy75V2烧录工具20261112-1beta1.html" --out inputs` 提取）
- `main-stock.bin` — 原厂键盘主控固件 `0x3F`（同上，一并解出）
- `libISP585.a` — WCH CH585 官方 SDK 的 Flash 操作静态库（编译主控固件时需要）
- `NotoSansCJKsc-Regular.otf` — 思源黑体（只有启用可选歌词扩展生成 `FONT.BIN` 时才需要）
