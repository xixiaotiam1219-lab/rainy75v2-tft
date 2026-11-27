# 白猫按键屏幕固件

这个可选 IPS 变体用原生键盘通知驱动 Bongo Cat。84 个键码对应独立的键帽位置和爪形，重复敲同一键会延长同一姿势。画面以 320×172 渲染，右侧键盘使用投影后的原生像素字形，左侧四个方向键共用键帽轮廓、命中区域与落点坐标。只显示最近一次通知，拍爪持续约 100 ms。

## 本地构建

准备已解压的 Bongo Cat Mver 0.1.6 F1–F12 包（含根目录的 config.json 与 img 目录）、合法取得的原厂 IPS 输入和支持 ARM 的 Clang/LLD。另准备 [ayangweb/BongoCat 的 keyboard/background.png](https://github.com/ayangweb/BongoCat/blob/HEAD/resources/models/keyboard/resources/background.png) 作为桌沿参考；验证过的文件 SHA-256 为 465f577b2d78b90e572f7e71c9d91f1d2e4233fc91961ad0fb3cc8556e378e8d。构建器只读取图层和配置。猫、爪子与桌沿图片的权利归原权利人；图片及派生固件需在本机生成。

以下版本用于复现已上机的镜像。建议在独立 Python 3.11 虚拟环境中运行：

~~~sh
python -m pip install Pillow==10.2.0 numpy==1.26.4 unicorn==2.1.4
python tools/build_keymap_pet.py --stock inputs/ips-stock.bin --model PATH_TO_EXTRACTED_MODEL --desk-image background.png --clang PATH_TO_CLANG
python tools/test_keymap_pet.py --build build/bongo --preview build/bongo/preview
~~~

构建目录含屏幕 BIN、manifest、配套 S1 GIF、用于仿真的 ELF 与按键坐标。模型测试逐键执行 ARM 代码，检查键帽着色、连按、百毫秒归位、 DMA 忙及计时器回绕。

## 安装

在本地服务器打开 web/index.html 的手动固件工具，选生成的 BIN 与 manifest。当前允许安装的白猫镜像 SHA-256 为 7b582a1336d22cb5b0aaba5b09b8d76545810481df322475f4e934a04db6c20c。保持 USB 有线连接，在 APP 模式检测 1024 KiB、系列 13 的 AT32F435，再选择 IPS 升级设备（PID 0x3078）。写入并逐段校验后，重连 APP，上传 manifest 的 petGif 到 S1，使用 GIF 播放 S1 模式。设备通过屏幕查询 OP11 / ID13 返回 0x4245。主控沿用现有支持原生按键通知和 L6 的固件。
