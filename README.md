# Scratch Trainer — 搓盘实时可视化与音游训练器（Rane One 适配版）

免费、零依赖的本地搓盘训练工具，复刻视频中的 **TTM 垂直滚动谱面 + 横推实时波形 + 切音命中判定**。

## 🍎 macOS + Rane One 一代 + Serato / djay 使用步骤

1. **拷贝整个 `scratch-trainer` 文件夹到你的 Mac 上**（例如放到桌面）。
2. **启动本地服务**（Web MIDI 需要在 `localhost` 下运行，必须用 **Chrome 或 Edge**）：
   - 首次在 Mac 上运行，打开终端执行一次赋权即可直接双击启动：
     ```bash
     chmod +x start_mac.command start_mac_sidebar.command
     ```
   - **侧边栏模式（推荐配合 Serato / djay 使用）**：双击 **`start_mac_sidebar.command`**，会以无地址栏的 `400px` 竖长 Chrome 独立小窗打开，直接贴在 Serato / djay 屏幕右侧当侧边栏使用！
   - **常规全屏模式**：双击 **`start_mac.command`**，在常规 Chrome 标签页打开 `http://localhost:8765`。
3. **连接 Rane One 一代**：
   - 将 Rane One 通过 USB 连接到 Mac，面板输入拨档切到对应的 `USB A` 或 `USB B`。
   - 因为 **macOS CoreMIDI 原生支持多软件共享**，你可以**同时开着 Serato DJ Pro 或 djay Pro**！
   - 如果想听 Serato / djay 里的伴奏和黑胶音色，点右上角打开 **「🎧 Serato/djay 伴随模式」**（静音本工具自带声音，专心看谱面与判定）。
4. **一键绑定横推与转盘**：
   - 点击右上角 **「🎛️ Rane One / MIDI 设置」**，确认下拉框已选中 `RANE ONE`。
   - 点 **「🎯 学习横推」** → 来回推一下 MAG FOUR 横推（自动兼容 14-bit 高精度 CC，支持 Hamster 反转和 Cut-In 阈值微调）。
   - 点 **「🎯 学习转盘」** → 来回搓一下转盘即可自动绑定。

## ⌨️ 无硬件试玩快捷键
- `Enter`：开始 / 暂停练习
- `Space` / `J` / `K` / `F`：模拟横推切音
- 在画布上**左右拖动鼠标**或**滚动滚轮**：模拟唱盘前推 / 后拉
