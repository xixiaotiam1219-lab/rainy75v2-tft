# 白猫按键屏幕固件

这个可选 IPS 变体用原生键盘通知驱动 Bongo Cat。84 个键码对应独立的键帽位置和爪形，重复敲同一键会延长同一姿势。画面以 320×172 渲染，右侧键盘保留倾斜透视，左侧保留原图四枚方向键，猫爪和高亮按各键的位置绘制。只显示最近一次通知，拍爪持续约 100 ms。

## 本地构建

准备已解压的 Bongo Cat Mver 0.1.6 F1–F12 包（含根目录的 config.json 与 img 目录）、合法取得的原厂 IPS 输入和支持 ARM 的 Clang/LLD。键帽文字使用系统可读的 Arial Bold（arialbd.ttf）。另准备 [ayangweb/BongoCat 的 keyboard/background.png](https://github.com/ayangweb/BongoCat/blob/HEAD/resources/models/keyboard/resources/background.png) 作为桌沿参考；验证过的文件 SHA-256 为 465f577b2d78b90e572f7e71c9d91f1d2e4233fc91961ad0fb3cc8556e378e8d。构建器只读取图层和配置。猫、爪子与桌沿图片的权利归原权利人；图片及派生固件需在本机生成。

以下版本用于复现已上机的镜像。建议在独立 Python 3.11 虚拟环境中运行：

~~~sh
python -m pip install Pillow==10.2.0 numpy==1.26.4 unicorn==2.1.4
python tools/build_keymap_pet.py --stock inputs/ips-stock.bin --model PATH_TO_EXTRACTED_MODEL --desk-image background.png --clang PATH_TO_CLANG
python tools/test_keymap_pet.py --build build/bongo --preview build/bongo/preview
~~~

构建目录含屏幕 BIN、manifest、配套 S1 GIF、用于仿真的 ELF 与按键坐标。模型测试逐键执行 ARM 代码，检查键帽着色、连按、百毫秒归位、 DMA 忙及计时器回绕。

## 安装

1. 准备已装兼容主控和普通屏幕固件的 Rainy75 V2。原厂设备可以先装[桌宠与按键版](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/tag/v0.2.0-alpha.8)。
2. 下载[独立的 Bongo Cat 构建与安装 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/tag/bongo-cat-v1)。用 Chrome 或 Edge 打开「安装白猫.html」，选择构建输出目录 `build/bongo`。如果浏览器限制直接打开本地文件，在解压目录运行 `python -m http.server 8765 --bind 127.0.0.1`，再通过浏览器打开 `http://127.0.0.1:8765` 并选择安装页。
3. USB 有线连接，退出 WOBHub 和歌词后台。点「开始安装」，选正常键盘。安装页会检查 1024 KiB、系列 13 的 AT32F435，提示选择屏幕升级设备（`0x3078`），写入并校验固件。
4. 等键盘重新出现，点「连接键盘并写入素材」。安装页会核对屏幕标识 `0x4247`，再传配套 GIF。若小屏仍显示原厂界面，可在 WOBHub 选择 GIF 槽位 1。

安装页接受本版已核对的屏幕镜像 SHA-256 `5d7b087f4f2e41eba3b803ef39ab4c0cb41b113b5f68ce4e8bbb24753106c940` 及配套 GIF。遇到不匹配时检查模型素材、编译器、依赖版本与构建参数。

安装写入屏幕应用区及 S1 素材槽。要切回其他界面，请安装相应的普通屏幕套件或歌词套件。若写入中断且原页面已关闭，请通过[恢复指南](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/blob/main/docs/recovery.md)恢复普通屏幕固件，再在正常模式检验屏幕芯片。

## 本机预览

运行上面的模型测试命令后，打开输出目录里的 `preview/bongo-response-model.gif`，可以看到待机、按键与眨眼。预览来自固件机器码模型，画面素材随本机输入生成。

## 素材与许可

公开套件包含项目源码与独立安装页。猫、爪和桌沿图层及含这些图层的成品在本机构建，相关素材权利归各自权利人。项目代码沿用 MIT。
