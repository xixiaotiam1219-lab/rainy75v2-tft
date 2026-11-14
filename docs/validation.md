# 验证范围

公开源码包使用三类检查：

1. **主机协议测试**：帧长度与校验、旧版 ACK 兼容、错误目标拒绝、烧录全部字节及尾块覆盖、校时读回、旧固件拒绝、素材覆盖确认。
2. **资源与构建检查**：三套原创 GIF 可逐帧解码，点阵边界与居中，原厂输入 SHA、补丁指令、原厂前缀与未声明区域保持不变，新增 ROM/RAM 边界。
3. **浏览器模拟**：离线像素编辑、导出、USB mock 的直接校时与旧版拒绝，桌面与移动布局。它不会访问真实 HID。

可选浏览器测试需另行安装 Playwright，不是运行网页的依赖：

```sh
npm install --no-save --package-lock=false playwright@1.56.1
npx playwright install chromium
node tests/browser.smoke.mjs
```

可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定本机 Chromium / Edge。测试会生成工作台截图 `assets/studio.png`，数据与验证结果留在被忽略的 `build/`。

开发阶段使用的已知旧工具链构建主控 7.1 时，可复现镜像 SHA：

```text
c9e26045df8dcabb37de6b06ed6c94fbf036edce32b371554878b4532beed1e9
```

该哈希仅是指定源码、输入、参数和编译器的复现参照。其他编译器版本可能产生不同代码；哈希一致也不证明硬件行为正确。这里不分发对应完整镜像。

**未完成的实机验证**：主控 7.1 校时标记修正、公开默认机器人素材、重新定制构建的显示、覆盖全部休眠与切换模式、完全关电后的使用体验，以及完整的输入延迟、功耗和稳定性测量。当前 README 必须继续标注 alpha 与这些限制。
