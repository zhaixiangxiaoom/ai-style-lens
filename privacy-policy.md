# StyleLens 隐私权政策

最后更新日期：2026-08-19

StyleLens（以下简称"本扩展"）尊重并保护用户隐私。本政策全面说明本扩展如何收集、处理、存储和共享用户数据，以及与哪些相关方共享数据。

## 一、我们收集哪些数据

本扩展**不收集任何个人身份信息**（如姓名、邮箱、电话号码等）。在您使用各项功能时，会涉及以下数据：

1. **页面设计数据**：当您主动点击扩展图标或按快捷键触发分析时，本扩展从当前页面读取样式信息（颜色、字体、间距、圆角、阴影、布局等设计 token）。
2. **分析历史记录**：最近 20 条分析结果（含 AI 解读内容，如有）。
3. **AI API Key 与服务配置**：仅当您选择启用 AI 解读功能时，您在设置页填写的 API Key、所选 AI 供应商、模型名称及自定义服务地址。
4. **页面截图**：仅当您已配置 API Key 并触发 AI 解读时，当前页面可见区域的截图（JPEG 格式）。

除上述数据外，本扩展不收集任何浏览历史、网站内容、Cookie、设备信息或位置信息。

## 二、我们如何使用数据

所有数据仅用于向您提供本扩展的核心功能，不用于任何其他目的：

| 数据 | 用途 |
|------|------|
| 页面设计数据 | 在侧边面板渲染设计规范，支持复制和导出 |
| 分析历史 | 供您本人离线回看与导出 |
| AI 配置 | 用于调用您所选的 AI 服务生成设计解读 |
| 页面截图 | 作为输入发送给您所选的 AI 服务以生成解读 |

本扩展**不包含**任何广告、用户行为分析、遥测（telemetry）或跟踪代码。

## 三、数据存储在何处、存储多久

1. **本地存储（chrome.storage.local）**：分析历史记录仅存储在您的浏览器本地，不设固定过期时间，由您自主控制。
2. **同步存储（chrome.storage.sync）**：AI API Key 与服务配置存储在您的 Chrome 账户同步存储中，仅在您本人的 Google 账户登录设备之间同步，受 Google 的隐私政策约束。
3. **开发者服务器**：本扩展开发者**没有任何服务器**，任何数据都不会发送到开发者处。
4. **删除方式**：您可通过以下任一方式随时删除全部数据：
   - 在设置页清空 API 配置；
   - 在扩展界面清除历史记录；
   - 卸载本扩展（卸载后浏览器将自动删除所有本地数据）。

## 四、数据与哪些相关方共享

1. **本扩展开发者**：不接收、不访问您的任何数据。
2. **AI 服务提供商（仅限您主动使用 AI 功能时）**：当您配置了 API Key 并触发 AI 解读时，浏览器将**直接**向您所选的 AI 供应商发送请求（包含页面截图与提取的设计 token）。本扩展支持的供应商包括：Anthropic、OpenAI、Moonshot（月之暗面）、阿里云百炼（Qwen）、智谱（Zhipu）、OpenRouter，以及您自行配置的自定义服务地址。相关数据的使用受该供应商自身隐私政策约束。
3. **Google（仅当您使用同步存储时）**：API Key 配置经 Chrome 同步存储在您本人的 Google 账户中，受 Google 隐私政策约束。
4. **其他第三方**：本扩展不与任何其他第三方共享、出售或传输任何数据。

除上述第 2、3 项所述情形外，本扩展不与任何第三方共享任何用户数据。

## 五、数据安全

- 数据保存在浏览器提供的隔离存储中，其他网站和扩展无法访问；
- 您的 API Key 仅在您的浏览器与您所选 AI 供应商之间传输，开发者无法获取；
- AI 请求通过 HTTPS 加密传输。

## 六、儿童隐私

本扩展不面向 13 岁以下儿童，也不刻意收集任何儿童的个人信息。

## 七、政策更新

本隐私政策如有更新，将在此页面发布并更新顶部的日期。继续使用本扩展即表示您同意本政策。

## 八、联系方式

如有隐私相关问题，请联系：1558968288@qq.com

---

# StyleLens Privacy Policy

Last updated: 2026-08-19

StyleLens ("the extension") respects and protects your privacy. This policy fully describes how the extension collects, processes, stores, and shares user data, and with whom the data is shared.

## 1. What Data We Collect

The extension collects **no personally identifiable information** (no name, email address, phone number, etc.). When you use its features, the following data is involved:

1. **Page design data**: When you actively trigger an analysis (via the toolbar icon or keyboard shortcut), the extension reads style information (colors, fonts, spacing, radii, shadows, layout — design tokens) from the current page.
2. **Analysis history**: The most recent 20 analysis results (including AI interpretation, if any).
3. **AI API key and service settings**: Only if you enable the AI feature — the API key, selected provider, model name, and custom endpoint entered on the settings page.
4. **Page screenshots**: Only when you have configured an API key and trigger AI interpretation — a JPEG screenshot of the visible page area.

Apart from the above, the extension collects no browsing history, website content, cookies, device information, or location data.

## 2. How We Use the Data

All data is used solely to provide the extension's core features and for no other purpose:

| Data | Purpose |
|------|---------|
| Page design data | Render the design specification in the side panel; enable copy and export |
| Analysis history | Allow you to review and export past results offline |
| AI settings | Call your chosen AI service to generate design interpretation |
| Page screenshots | Serve as input sent to your chosen AI service to generate interpretation |

The extension contains **no** advertising, user analytics, telemetry, or tracking code.

## 3. Where Data Is Stored and for How Long

1. **Local storage (chrome.storage.local)**: Analysis history is stored only in your browser, with no fixed expiration — you are fully in control.
2. **Sync storage (chrome.storage.sync)**: Your AI API key and service settings are stored in your Chrome account's sync storage, synchronized only among your own devices signed into your Google account, subject to Google's privacy policy.
3. **Developer servers**: The developer operates **no servers**; no data is ever sent to the developer.
4. **How to delete**: You can delete all data at any time by:
   - Clearing the AI configuration on the settings page;
   - Clearing the history in the extension UI;
   - Uninstalling the extension (your browser automatically removes all local data after uninstallation).

## 4. With Whom Data Is Shared

1. **The extension developer**: Never receives or accesses any of your data.
2. **AI service providers (only when you actively use the AI feature)**: When you have configured an API key and trigger AI interpretation, your browser sends requests **directly** to your chosen AI provider (containing the page screenshot and extracted design tokens). Supported providers include Anthropic, OpenAI, Moonshot, Alibaba Cloud (Qwen), Zhipu AI, OpenRouter, and any custom endpoint you configure. The provider's own privacy policy governs such data.
3. **Google (only when sync storage is used)**: Your API key configuration is synced through Chrome under your own Google account, subject to Google's privacy policy.
4. **Any other third party**: The extension shares, sells, or transmits no data to any other third party.

Except as described in items 2 and 3 above, the extension shares no user data with any third party.

## 5. Data Security

- Data resides in the browser's isolated storage, inaccessible to other websites and extensions;
- Your API key travels only between your browser and your chosen AI provider; the developer can never obtain it;
- AI requests are transmitted over HTTPS.

## 6. Children's Privacy

The extension is not directed at children under 13 and does not knowingly collect any personal information from children.

## 7. Changes to This Policy

Any updates to this policy will be posted on this page with the date above revised. Continued use of the extension constitutes acceptance of this policy.

## 8. Contact

For privacy questions, contact: 1558968288@qq.com
