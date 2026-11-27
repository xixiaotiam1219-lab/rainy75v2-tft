# Rainy75 V2 一键安装

下载一个 ZIP，解压后双击 **点我安装.cmd**。用 USB 数据线连接键盘，切到有线档，退出 WOBHub，再点 **开始安装**。浏览器弹出设备列表时，选择页面提示的设备。

| 想要的画面 | Windows x64 安装包 |
| --- | --- |
| 桌宠、按键、时钟和电量 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-keys-windows-x64.zip) |
| 经典双行歌词 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-lyrics-classic-windows-x64.zip) |
| 大字字幕 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-lyrics-caption-windows-x64.zip) |
| 大字聚焦 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-lyrics-focus-windows-x64.zip) |
| 双行大字 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-lyrics-double-windows-x64.zip) |
| 沉浸封面 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-lyrics-cover-windows-x64.zip) |
| Bongo Cat 白猫按键 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-bongocat-windows-x64.zip) |

七个 ZIP 分别安装。Bongo Cat 使用 84 键本地拍爪，屏幕需为 1024 KiB／系列 13。歌词版各自启动对应的独立版式。安装后打开 QQ 音乐或网易云音乐播放即可。歌词同步需要 Windows 后台和 USB 有线连接，安装页可以关掉。以后双击「点我安装.cmd」并选「启动歌词同步」，也可以在「歌词设置」开启登录自启或调整延迟。桌宠与按键版安装后由键盘独立运行。

支持原厂主控 **0.63-beta1、0.64、0.71**。安装器读取主控版本后选择对应镜像，歌词版安装前还会核对屏幕容量和芯片系列。兼容的主控、屏幕固件和字库可复用。安装会替换屏幕第 1 个 GIF。若小屏仍显示原厂界面，暂停歌词后台，在 WOBHub 里把屏幕切到 GIF 槽位 1，然后退出 WOBHub。

## 删除屏内字库

如果要切换成桌宠版，可在写入桌宠固件前打开安装器底部的「删除屏内字库」。先暂停歌词同步，点「删除字库」并确认。项目自带的字库可直接核对，自行更换过字库的用户可以选回原 FONT.BIN。删除完成后再开始安装桌宠版。此操作需要当前屏幕固件支持字库管理。

## 手动刷写与恢复

[下载定制固件与恢复 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.9/rainy75v2-custom-firmware-and-recovery.zip)。内有三个主控基线的定制与恢复镜像、两种屏幕定制镜像和原厂屏幕恢复镜像，以及 0.71 单文件更新、校时与校频页。

安装中断时保持 USB 供电，在原窗口点「再试这一步」。如果只看到升级设备且原窗口已关闭，按固件包内的恢复说明选择相应的芯片和出厂版本。[恢复指南](recovery.md)

## 重新打包

用上一版公开工作台的完整解压目录作为已验证的旧基线和便携运行时来源。按 [0.71 构建说明](clock-071.md) 准备匹配的定制、恢复镜像及模型验证结果。按 [白猫构建说明](keymap-pet.md) 生成公开版屏幕固件和预览后运行：

```sh
python tools/pack_editions.py --public dist/rainy75v2-tft-studio-20261116 --main071 build/official071 --bongo-dir build/bongocat-facing-public --all-editions --out dist/rainy75v2-alpha9
```

一键安装包只含公开素材。歌词版共用同一款屏幕固件和字库，电脑后台根据各包固定版式。它们共用键盘上的 S1 槽位，安装另一个包会替换当前槽位画面。
