# 定制图标、素材与主题

当前工作台支持编辑既有大图标的点阵、导入／导出图标 JSON 和预览三套主题。导出的配置不会直接写入设备；使用它生成资源并重新编译 IPS 后才生效。

## 大按键图标

`profiles/keys.json` 中每个 glyph 包含：

```json
{
  "key": 227,
  "name": "Windows",
  "rows": ["111101111", "111101111", "111101111", "111101111", "000000000", "111101111", "111101111", "111101111", "111101111"]
}
```

`1` 为前景像素，`0` 为背景。每个单元以 6×6 显示，图标居中于 120×76 区域。限制为宽 1–16、高 1–11，行宽一致、键码唯一。

常用键码：A `4`、Enter `40`、Backspace `42`、Space `44`、PgUp `75`、PgDn `78`、左右上下 `80/79/82/81`。原厂负修饰键会归一化到 `224..231`；左右 Win 共用 `227` 图标。没有独立大图标的普通字符由 5×7 字体渲染。ESC / CTRL / ALT 默认走文字路径。

```sh
python tools/build.py ips --stock inputs/ips-stock.bin --keys "/path/to/exported-keys.json" --theme pink
```

`idleTimeoutMs` 当前固定为 0：显示最后一键，不自动清空。不要仅改 JSON 就期待固件拥有新的超时或事件处理功能。

## 配色与默认机器人

`profiles/themes.json` 包含背景、键帽面板、边框、前景与强调色。修改后用相同主题生成 IPS 和缓存 GIF：

```sh
python tools/assets.py --theme mint --out build/my-assets
python tools/build.py ips --stock inputs/ips-stock.bin --theme mint
```

原始机器人绘制逻辑在 `tools/assets.py`，没有外部角色图。自己的角色或 GIF 可自行替换，但应确认对应权利；不要把私人角色、宠物标识或未授权素材带入公开提交。

`robot-*.gif` 不包含写死的实时键位、时间或电量，动态内容由固件叠加。更换素材会覆盖 S1 槽位，需通过工作台显式确认。

## 布局与字体

界面坐标来自 `tools/assets.py` 的 `REGIONS`，模块 mask 总大小为 1378 字节；背景、头文件与固件要保持一致。当前网页编辑器不提供任意拖拽布局。修改区域尺寸、新增组件或改变掩码分配属于源码开发，需要同步检查内存界限、字体、自定义图标与构建结果。

`profiles/font.json` 存放可编辑像素单元格，不是桌面字体文件。固件支持基本可打印 ASCII 和有限图标，使用 Unicode 标签不等于固件支持该字符。新增字符应同时修改编码、字形和协议测试。
