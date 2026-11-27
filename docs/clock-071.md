# 0.71 主控与时钟校频

专用单文件网页支持 Rainy75 V2 的 WOBHub `20261124-1` 主控固件。先连接主控并核对 `0.71`，再授权 `0x3079` 写入。更新后在同一网页用 USB 有线运行「测量并校准」，默认测量 10 分钟。

显示的时刻取自 CH585 RTC 计数，屏幕收到主控快照后继续走秒。频率估计使用同一台电脑的单调计时与键盘原始计数，避开屏幕秒数取整。测量完成后保存毫赫兹频率和校时锚点。需要在完全断电后恢复时间时，可以用同一网页按上次保存的频率重新校时。温度或时钟源改变会影响走时精度，测量效果以长时间实机对比为准。

0.71 原厂映像截至 `0x49890`，已覆盖旧版 `0x49000` 校时页。新补丁把校时记录放在主控镜像最后的 `0x49F60..0x49FFF`，镜像总长度仍为 `294912` 字节。每次成功校时追加 16 字节，最多十条。运行时调用这份原厂镜像现有的 Flash 编程例程，只写校时记录，并最后提交校验字。空间用尽时校时会停止，旧记录继续有效。需要释放记录空间时可重新写入相同版本的主控补丁。

## 从本地原厂文件构建

使用 WOBHub 包内 `20261124-1/main-core.bin`。构建脚本核对 SHA-256，并使用对应的原厂指令和地址。用以下命令构建主控和同版本恢复镜像，并运行模型及打包步骤。

```sh
python tools/build.py main --stock inputs/main-071.bin --out build/official071
python tools/build.py main --stock inputs/main-071.bin --out build/official071 --restore-stock
python tools/test_main_model.py --stock inputs/main-071.bin --build build/official071/main
python tools/pack_clock071.py --build build/official071 --out build/official071/Rainy75V2-0.71-Clock.html
```

机器码模型覆盖原厂启动、USB 命令转发、屏幕时钟回复、跨日计时和 Flash 写入边界。原厂恢复镜像是配套输入的重建镜像。单台开发机已通过 0.71 主控的全字节烧录校验、有线校频、校时记录及屏幕走秒读回。长时误差、休眠和无线走时仍待对比。
