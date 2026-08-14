# ai-style-lens (StyleLens)

> 一键读懂任何网站的设计基因，生成可被 AI Agent 直接消费的设计规范文档。

Chrome 浏览器插件（Manifest V3）。产品设计详见 `StyleLens-产品设计文档`，UI 演示见 [demo/stylelens-demo.html](demo/stylelens-demo.html)。

## 核心特性

- **无 Key 可用**：一键提取颜色 / 字体 / 间距 / 圆角 / 阴影 / 布局，Side Panel 1 秒内渲染
- **全量可复制**：任意 token 整行点击即复制对应 CSS 声明，Toast 动态配色反馈
- **导出 MD**：标准格式设计规范文档（含 CSS 声明列），可直接交给 Cursor / Claude Code 使用
- **AI 设计解读（需 Key）**：配置后解锁风格标签、设计意图、Agent 指令建议；
  支持 **Anthropic Claude** 与 **OpenAI 兼容协议**（OpenAI / Kimi / Qwen / GLM / OpenRouter / 自建服务），
  设置页含供应商预设与连接测试
- **双阶段渲染**：tokens 先行，AI 解读流式生成后淡入；模型挂了工具依然完整可用
- **Mood Board 自适应**：背景色 = 目标站主背景色，文字对比度自动计算
- **暗色模式**：跟随系统 `prefers-color-scheme`，纯 CSS 变量实现

## 目录结构

```
├── manifest.json       # MV3 清单（side panel / 快捷键 / 权限）
├── content.js          # 设计元素提取，按需注入目标页面
├── background.js       # Service Worker：消息中转 + 双协议 AI 调用 (Streaming)
├── sidepanel.html      # 结果展示
├── sidepanel.js        # Side Panel 逻辑 + 导出
├── sidepanel.css       # Side Panel 样式（含暗色模式）
├── options.html        # 设置页
├── options.js          # AI 配置管理（多供应商 + 连接测试）
├── icons/              # 棱镜分光图标 16/48/128
└── demo/               # UI 对齐演示（静态 HTML）
```

## 安装与使用

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本目录
3. 浏览任意 http/https 网站，点击插件图标或按 `⌘/Ctrl + Shift + S`
4. （可选）右键插件 → 选项 → 选择供应商并填 Key（或 OpenAI 兼容的 Base URL + 模型），解锁 AI 解读

## 技术要点

- 提取策略：CSS 变量优先 → Computed Styles 兜底；视口内采样限 400 元素；频次统计 + GCD 推算间距单元
- API 调用：双协议适配器（Anthropic 原生 / OpenAI 兼容），Streaming 读取 SSE，规避 Service Worker 30s idle timeout；截图自动缩放至 1568px 内
- 存储：`chrome.storage.sync` 存 Key（跨设备同步）
- 展示与导出同源：Side Panel 与 MD 均从同一数据对象生成
