# 本地构建

所有第三方输入都由使用者自行取得并保留在本机。构建脚本没有自动下载 SDK、自动烧录或上传文件的步骤。

## 依赖

- Python 3.10+，推荐 3.12。
- Pillow：`python -m pip install -r requirements-dev.txt`。建议使用虚拟环境。
- LLVM Clang 与 LLD，需包含 ARM、RISC-V 后端。通过 `--clang` 指定可执行文件，或放入 PATH。
- 主控构建另需 WCH `libISP585.a`，见下面的版本约束。
- Node.js 22+ 用于测试或可选歌词后台；基础浏览器工具不需要 npm 依赖。字库生成另用 fontTools，已列在开发依赖中。

## 原厂输入

仅支持以下 APP 镜像，输入不匹配会停止构建，没有强制跳过参数：

| 本地文件 | SHA-256 |
| --- | --- |
| `inputs/ips-stock.bin` | `32defab7902e57eb972a577fc6cbf3a7e57bc772d59b99f11038370412b77f41` |
| `inputs/main-stock.bin` | `bc575a6d7b19042048705248715a43a67a23c7f217ba0ac464c539a390f4d23b` |

对应原厂 IPS `0x0002`、主控 beta1 `0x3F`。原厂 `.bin` 为从 APP 起点开始的镜像，不是带前置 bootloader 的全芯片转储。

如果你合法取得的是包含该版本的原厂烧录 HTML，可在本机提取；脚本只解析数据，不执行其中 JavaScript：

```sh
python tools/extract_stock.py "/path/to/factory-flasher.html" --out inputs
```

提取后仍逐一核对上述哈希。格式或版本不同会拒绝，不要靠重命名文件绕过检查。输入目录除说明文件外全部被 Git 忽略。

## 屏幕

```sh
python tools/build.py ips --stock inputs/ips-stock.bin --theme pink
```

或显式指定 Clang，Windows 路径有空格时用引号：

```sh
python tools/build.py ips --stock inputs/ips-stock.bin --clang "/path/to/clang" --theme mint
```

产物：

- `build/ips/rainy75v2-ips.bin`
- `build/ips/manifest.json`
- `build/ips/assets/robot-<theme>.gif`
- 仅本机构建目录中的 ELF 与生成头文件。

图标定制可加 `--keys /path/to/keys.json`。可选主题为 `pink`、`mint`、`mono`。不传 `--out` 时所有构建产物留在被忽略的 `build/`。

普通 IPS 现在增加了只读的芯片容量／系列查询，公开 UI 候选标为 0.6.3，仍保留 L6 能力值。需要歌词时，按 [独立歌词文档](lyrics.md) 生成字库，再使用 `--lyrics --font build/font/FONT.BIN`。该分支输出到 `build/ips-lyrics/`，普通版保留在 `build/ips/`，不互相覆盖。

## 主控

从 [官方 CH585 SDK](https://github.com/openwch/ch585/tree/db889195f07b8f3f4e7bf2c55f96a35daa14bebf) 自行取得：

```text
EVT/EXAM/SRC/StdPeriphDriver/libISP585.a
```

构建器要求该归档 SHA-256 为：

```text
8ede32a24e09344e86ecd74731069e19d6befa287bd6de2dd7c757c6f1d06a9e
```

检查该 SDK 的许可及适用芯片条件后，将其放在本地 `inputs/libISP585.a`：

```sh
python tools/build.py main --stock inputs/main-stock.bin --isp-lib inputs/libISP585.a
```

现代 Clang 默认使用 `rv32imac_zicsr_zifencei`。使用仍把 CSR / fence.i 包含在旧基础集合中的工具链时，可显式选择：

```sh
python tools/build.py main --stock inputs/main-stock.bin --isp-lib inputs/libISP585.a --clang "/path/to/clang" --riscv-march rv32imac
```

产物为 `build/main/rainy75v2-main.bin` 和 `build/main/manifest.json`。SDK 在本机生成的 blob 头文件只存在于构建目录，不进入源码仓库。

主控新固件初始时钟数据区为空。刷入完成后再用网页校时；无需提前记录设备计数或把电脑时间写进源码。

## 生成原厂恢复产物

该步骤不需要 SDK 或编译器，仍会核对原厂输入哈希：

```sh
python tools/build.py main --stock inputs/main-stock.bin --restore-stock
python tools/build.py ips --stock inputs/ips-stock.bin --restore-stock
```

分别得到 `build/main-restore/`、`build/ips-restore/` 内的恢复 BIN 和清单。它们是使用者提供的原厂 APP 加擦除填充，**不是设备实际 Flash 读回备份**。

## 构建器检查

- 原厂文件 SHA、原始分支指令、前 512 字节与非补丁区域不变。
- IPS 只替换八个已列明的 BL，新增代码限制在 `0x0807EC90..0x08080000`，模块状态限制在 `0x2005F000..0x20060000`。
- 可选歌词分支使用同一原厂 SHA 与八个 hook，新代码严格限定在 `0x08080000..0x08088000`，只支持已通过 APP 只读核验的 1024KiB AT32F435。生成镜像 540672 字节，保留更高处的原厂设置区；不依赖私人测试固件前缀。
- 主控只替换四处已列明的调用／跳转，代码不得侵入 `0x49000`；`0x49000..0x49FFF` 为独立校时页。
- 指定版本 SDK 不得含新的 `.data` / `.bss` 或未解析符号；重定位须在允许的相对类型和被复制代码段之内。
- SHA 与边界检查不证明任何未测试硬件布局安全，也不能代替恢复入口和实机验证。

## 测试

```sh
python -m unittest discover -s tests -p "test_*.py"
npm test
```

仓库测试覆盖主机协议、错误目标拒绝、全部烧录字节覆盖、校时流程与素材生成。开发阶段还使用了真实指令与模拟外设的模型；它们仍不是物理设备证明。每次修改固件或关键地址后应重新构建并审查差异，再进行有记录的实机测试。
