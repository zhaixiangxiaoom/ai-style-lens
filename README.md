# ai-style-lens (StyleLens)

> 一键读懂任何网站的设计基因，生成可被 AI Agent 直接消费的设计规范文档。

Chrome 浏览器插件（Manifest V3）。产品设计详见 `StyleLens-产品设计文档`，UI 演示见 [demo/stylelens-demo.html](demo/stylelens-demo.html)。

## 核心特性

- **无 Key 可用**：一键提取颜色 / 字体 / 间距 / 圆角 / 阴影 / 布局，Side Panel 1 秒内渲染
- **全量可复制**：任意 token 整行点击即复制对应 CSS 声明，Toast 动态配色反馈
- **导出矩阵**：Markdown 规范 / W3C Design Tokens JSON / tailwind.config.js / Agent Prompt 一键复制，
  可直接交给 Cursor / Claude Code 或导入设计工具链
- **历史库**：自动保存最近 20 条分析（含 AI 解读），离线可回看、可导出
- **AI 设计解读（需 Key）**：配置后解锁风格标签、设计意图、Agent 指令建议；
  支持 **Anthropic Claude** 与 **OpenAI 兼容协议**（OpenAI / Kimi / Qwen / GLM / OpenRouter / 自建服务），
  设置页含供应商预设（可回显）与连接测试
- **AI 流式预览**：生成期间风格标签先行、解读文本逐字流入，等待过程可见
- **双阶段渲染**：tokens 先行，AI 解读流式生成后淡入；模型挂了工具依然完整可用
- **提取质量**：颜色按页面实际使用频次排序，剔除“仅声明未使用”的调色板变量；圆角钳位值归一
- **语义色**：在扁平色板之外提取角色层——按钮主色、链接、边框/输入框边框，并解析 `:hover`
  规则得到交互态色对，AI 与四种导出直接消费“哪个色干什么用”
- **Mood Board 自适应**：背景色 = 目标站主背景色，文字对比度自动计算
- **暗色模式**：跟随系统 `prefers-color-scheme`，纯 CSS 变量实现

## 目录结构

```
├── manifest.json       # MV3 清单（side panel / 快捷键 / 权限）
├── content.js          # 设计元素提取，按需注入目标页面
├── background.js       # Service Worker：消息中转 + 双协议 AI 调用 (Streaming)
├── sidepanel.html      # 结果展示
├── sidepanel.js        # Side Panel 逻辑 + 历史库 + 导出矩阵
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

- 提取策略：CSS 变量优先 → Computed Styles 兜底；视口内采样限 400 元素；频次统计 + GCD 推算间距单元；
  颜色变量按全页 DOM 实际使用频次排序（容差匹配 oklch/lab 转换舍入差），剔除仅声明未使用项；
  语义色：交互元素（button/a/input）显式采样不限视口，遍历同源样式表 `:hover` 规则以
  `el.matches` 匹配角色元素、文档顺序覆盖语义取 hover 态，跨域样式表与无 hover 站点优雅降级
- API 调用：双协议适配器（Anthropic 原生 / OpenAI 兼容），Streaming 读取 SSE；
  keepalive 端口防止长流式请求中 Service Worker 被终止；空闲制超时（90s 无新数据）适配慢速 VL 模型；
  流式过程增量解析 tags/summary/intent 推送面板预览；截图自动缩放至 1568px 内
- 存储：`chrome.storage.sync` 存 Key（跨设备同步）；`chrome.storage.local` 存历史分析
- 展示与导出同源：Side Panel 与四种导出格式均从同一数据对象生成
