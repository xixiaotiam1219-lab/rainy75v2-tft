# 协议与构建边界

以下为本项目实现的兼容信息，不是厂家承诺的稳定 API。均使用本地 USB 本体 `36B0:3075 / FF60:61 / Report ID 0 / 256B`；接收器不支持这些写屏操作。

## 主控／屏幕控制

控制报文：

```text
BE 1A LEN 0D OP ID_LO ID_HI 00 [PAYLOAD] SUM_LO SUM_HI ED
```

`LEN = 11 + payload长度`。SUM16 为下标 3 到 payload 末尾的字节和，低字节在前。发送时填充至 256 字节。

使用 E4 读取四字节应答描述符：

```text
请求：BE E4 0A 84 04 00 00 34 02 ED
响应：BE E4 0E 84 04 00 00 SUB STATUS VALUE_LO VALUE_HI SUM_LO SUM_HI ED
```

响应正常 SUM16 覆盖下标 0–10。部分厂商版本返回固定的旧式请求回显校验 `0357`；`parseAck` 明确标记此兼容情况，它不等于对响应正文的完整性验证，更不提供认证或加密。

| 操作 | 含义 |
| --- | --- |
| 主控 OP15 / ID9 | V7.1 能力值 `4350`；其他主控查询状态为 `D0+ID` |
| 主控 OP18，8B payload | `secondsOfDay:u32LE` + `rate:u32LE`；主控在收到后读取自身 RTC 并持久校准 |
| IPS OP11 / ID0 | L6 能力值 `5536`；查询状态为 `B0+ID` |
| IPS OP11 / ID1,2,3 | 最近键码、电量/充电原始值、连接模式原始值 |
| IPS OP11 / ID4,5,6 | 时钟源状态、BCD 时间低/高 16 位 |
| IPS OP11 / ID14,15 | 只读 F_SIZE（KiB）与 UID 系列字节；本版普通 IPS 和歌词版均提供 |
| IPS OP2 / OP5 | 暂停合成／文件上传准备，以及恢复 |

通用成功状态为 `1`，忙为 `2`，格式为 `3`，范围错误为 `5`，失败为 `7`。主控校时失败不应表述为已成功校时。

V7.1 主控附加只读查询：10/11 guard 低/高、12/13 参考计数低/高、14 参考日、15 guard 是否有效，16/17 magic、18/19 参考秒数、20/21 rate、22/23 checksum 的低/高部分。

## 原生串口事件

- 按键：`BE 15 08 KEY_LO KEY_HI RAW5 RAW6 ED`。当前匹配版本的 RAW6 是 Shift 布尔值，不能按标准 HID 修饰键位图解释。
- 原生状态：`BE 19 07 BATTERY CHARGE MODE ED`。当前映射 USB=1、2.4G=0、蓝牙槽位=2..4，其他硬件版本需验证。
- 屏幕取时：`BE 1D 04 ED`。
- 主控时间：`BE 1A 08 0D (80|HOUR) MIN SEC ED`；未知时间 `BE 1A 08 0D 9F 00 00 ED`。

屏幕开机或未知时间时每秒重试，已同步时每 30 秒取样并本地插值，超过 90 秒未获有效快照则时间失效。UART 忙时丢弃当前快照等待重试，不为正常时钟发送忙等。

## 素材

文件协议为原厂 1A 子命令：BEGIN=1、DATA=2、END=3、ABORT=4。文件名使用 11 字节 `S1      GIF`，文件大小 u32LE，CRC16 CCITT 初值 FFFF、多项式 1021，无最终异或。DATA 使用 u16LE 包序号，通常每包 232 字节。

本工具只提供显式覆盖 S1 的 GIF 上传，不改变按键配置或捕获电脑全局输入。素材上传是持久文件写入，不是正常动态显示路径。

歌词版额外提供固定 `FONT    BIN` 文件名的字库上传，使用同一 BEGIN/DATA/END/ABORT 协议。写入前验证 R75F/2 头、索引、字形范围和双 CRC，并比对固件期望 body CRC；明确确认后才写入。普通 L6 拒绝歌词 HELLO 时不会开始字库写入。

## 可选 LY1 歌词扩展

| OP | 内容 | 应答 |
| --- | --- | --- |
| 24 | HELLO，无 payload；请求 GUI worker 初始化字库 | `A6 / 4C59` |
| 20 | 同 revision 分三字段：kind0 标题、1当前、2下一句；`kind:u8,count:u8,ids:u16LE[]`，每字段≤96字形 | `DONE / revision` |
| 21 | 提交三个完整字段；positionMs:u32、durationMs:u32、playing:u8、scrollElapsed:u32、scrollSpan:u32 | `QUEUED / revision`，再查真正 committed revision |
| 25 | 同17字节计时 payload，不重新读取字体 | `DONE / sequence` |
| 23 | payload0=按键页，1=歌词页 | `DONE`，查询实际模式确认 |
| 22 | 查询状态 | `C0+field / value` |

OP22字段：0 ready；1 mode；2 error；3 committed revision；4 job及queued；5/6编译期字体bodyCRC低/高；7标题字形上限。重连先等旧任务完成并从 committed revision 续号，不能从固定序号覆盖未完成任务。

字体格式 R75F/2：256字节头，排序Unicode u32索引，每字52字节（advance/flags加20×20单色50字节）。固件编译绑定 count、offset、total和bodyCRC；电脑、固件、屏内 FONT.BIN须同源。UTF-8不直接发送到设备，后台NFC规范化后转字形索引；超出覆盖回退为方框。

字形文件读取和位图生成只在GUI worker、LCD DMA不忙时处理，每轮最多四个52B字形读取。已有标题和预载下一句的不可变mask可复制复用，分配失败保持已发布画面。标题独立滚动，不受歌词换句或计时重置影响。

歌词页接管原GIF下半屏，返回按键页要等真正解码的新完整帧。公开机器人每帧恢复完整320×172，像素(22,39)的RGB565颜色必须不同于主题背景；自定义动画必须满足此条件，构建器与素材测试会校验。

## IAP

主控 `3079/0x2000`、IPS `3078/0x4000`，Report ID 0 / 64B：

- ERASE：`81 00 address:u32LE`，应答前两字节 0。
- PROGRAM：`80 N data`，N≤62；结束刷新 `80 00`。
- VERIFY：`82 N address:u32LE data`，N≤56；末尾不足 56B 时用重叠块覆盖尾部。
- END：`83 00`，不要求应答。

项目工具核对目标、应用起点、固定镜像大小和构建 SHA，再写入应用区。不提供 bootloader 修改、任意地址刷写或 Flash 读回功能。SHA 用于完整性检查，不是签名或来源认证。

歌词清单额外要求 variant=`lyrics-v1`、540672字节、F_SIZE1024KiB、系列0x0D、Bank2范围08080000..08088000、已核实IAP擦除终点080C0000。网页先在APP读取F_SIZE/系列，再允许歌词版IAP写入。普通IPS仍为507904字节；歌词扩展不改变主控镜像大小和起点。

## 校时数据页

主控专用页 `0x49000..0x49FFF` 不含程序代码。参考记录依次为 magic、cycles、seconds、rate、day、XOR checksum（各 u32），后接 guard。显式校时只擦除此页，先写包括 guard 的 24B 数据，最后提交 4B magic，再读回。计数回退时记录失效。SDK 的硬件就绪等待仍可能在外设故障时阻塞。
