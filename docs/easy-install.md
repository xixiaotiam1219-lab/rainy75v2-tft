# Rainy75 V2 一键安装

下载一个 ZIP，解压后双击 **点我安装.cmd**。用 USB 数据线连接键盘，切到有线档，退出 WOBHub，再点 **开始安装**。浏览器弹出设备列表时，选择页面提示的设备。

| 想要的画面 | Windows x64 安装包 |
| --- | --- |
| 桌宠、按键、时钟和电量 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.7/rainy75v2-keys-windows-x64.zip) |
| 经典双行歌词 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.7/rainy75v2-lyrics-classic-windows-x64.zip) |
| 大字字幕 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.7/rainy75v2-lyrics-caption-windows-x64.zip) |
| 大字聚焦 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.7/rainy75v2-lyrics-focus-windows-x64.zip) |
| 双行大字 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.7/rainy75v2-lyrics-double-windows-x64.zip) |
| 沉浸封面 | [下载 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.7/rainy75v2-lyrics-cover-windows-x64.zip) |

歌词版各自启动对应的独立版式。安装后打开 QQ 音乐或网易云音乐播放即可。歌词同步需要 Windows 后台和 USB 有线连接，安装页可以关掉。以后双击「点我安装.cmd」并选「启动歌词同步」，也可以在「歌词设置」开启登录自启或调整延迟。桌宠与按键版安装后由键盘独立运行。

支持原厂主控 **0.63-beta1、0.64、0.71**。安装器读取主控版本后选择对应镜像，歌词版安装前还会核对屏幕容量和芯片系列。兼容的主控、屏幕固件和字库可复用。安装会替换屏幕第 1 个 GIF。若小屏仍显示原厂界面，暂停歌词后台，在 WOBHub 里把屏幕切到 GIF 槽位 1，然后退出 WOBHub。

## 手动刷写与恢复

[下载定制固件与恢复 ZIP](https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases/download/v0.2.0-alpha.7/rainy75v2-custom-firmware-and-recovery.zip)。内有三个主控基线的定制与恢复镜像、两种屏幕定制镜像和原厂屏幕恢复镜像，以及 0.71 单文件更新、校时与校频页。

安装中断时保持 USB 供电，在原窗口点「再试这一步」。如果只看到升级设备且原窗口已关闭，按固件包内的恢复说明选择相应的芯片和出厂版本。[恢复指南](recovery.md)

## 重新打包

用上一版公开工作台的完整解压目录作为已验证的旧基线和便携运行时来源。按 [0.71 构建说明](clock-071.md) 准备匹配的定制、恢复镜像及模型验证结果后运行：

```sh
python tools/pack_editions.py --public dist/rainy75v2-tft-studio-20261116 --main071 build/official071 --out dist/rainy75v2-alpha7
```

一键安装包只含公开素材。歌词版共用同一款屏幕固件和字库，电脑后台根据各包固定版式。它们共用键盘上的 S1 槽位，安装另一个包会替换当前槽位画面。
