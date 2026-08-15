# StyleLens 隐私权政策

最后更新日期：2026-08-15

StyleLens（以下简称"本扩展"）尊重并保护用户隐私。本政策说明本扩展如何处理您的数据。

## 一、数据收集

本扩展不收集、不上传任何用户个人身份信息。具体说明：

1. **设计提取数据**：当您主动触发分析时，本扩展在您的浏览器本地读取当前页面的样式信息（颜色、字体、间距等），这些数据仅存储在您的浏览器本地（chrome.storage.local），不会上传至任何服务器。

2. **分析历史**：最近 20 条分析结果保存在您的浏览器本地，仅供您本人回看和导出。

3. **AI API Key**：如果您选择配置 AI 功能，您填写的 API Key 仅存储在浏览器本地（chrome.storage.sync，可跨您的设备同步）。调用 AI 服务时，请求直接发送至您选择的 AI 供应商（如 Anthropic、OpenAI 等），不经过本扩展开发者的任何服务器。

4. **页面截图**：仅在您配置了 API Key 并触发 AI 解读时，本扩展会截取当前页面可见区域的截图，并将其作为请求的一部分直接发送给您配置的 AI 供应商，用于生成设计解读。截图不会存储或发送给其他任何方。

## 二、数据使用

所有本地存储的数据仅用于向您提供本扩展的功能展示（侧边面板渲染、历史回看、导出）。

## 三、第三方服务

本扩展不自带任何第三方分析、广告或跟踪服务。当您使用 AI 解读功能时，相关数据受您所选 AI 供应商的隐私政策约束，请参阅其官方隐私政策。

## 四、权限说明

- **sidePanel**：在侧边面板中展示分析结果
- **storage**：本地存储 AI 配置与分析历史
- **scripting**：在用户主动触发时注入提取脚本
- **activeTab**：响应用户点击，访问当前标签页
- **tabs**：定位当前标签页、与提取脚本通信、截取可见区域截图
- **主机权限**：支持在任意网站上进行分析

## 五、政策更新

本隐私政策如有更新，将在此页面发布。继续使用本扩展即表示您同意本政策。

## 六、联系方式

如有隐私相关问题，请联系：[请填写您的联系邮箱]

---

# StyleLens Privacy Policy

Last updated: 2026-08-15

StyleLens ("the extension") respects and protects your privacy.

## 1. Data Collection

The extension collects no personally identifiable information:

- **Design extraction data**: When you trigger an analysis, style information (colors, fonts, spacing, etc.) is read locally in your browser and stored only in chrome.storage.local. It is never uploaded.

- **Analysis history**: The last 20 results are stored locally for your own review and export.

- **AI API key**: If you configure the AI feature, your API key is stored in chrome.storage.sync (synced across your own devices). AI requests are sent directly to your chosen provider (e.g., Anthropic, OpenAI) and never pass through the developer's servers.

- **Page screenshots**: Only when you have configured an API key and trigger AI interpretation, a screenshot of the visible page area is sent directly to your configured AI provider to generate the interpretation. It is never stored or shared elsewhere.

## 2. Data Usage

All locally stored data is used solely to provide the extension's features (side panel rendering, history review, export).

## 3. Third-Party Services

The extension includes no analytics, advertising, or tracking services. When using the AI feature, data is subject to your chosen AI provider's privacy policy.

## 4. Permissions

- **sidePanel**: display analysis results in the side panel
- **storage**: store AI configuration and analysis history locally
- **scripting**: inject the extraction script when the user triggers analysis
- **activeTab**: access the current tab upon user click
- **tabs**: locate the active tab, communicate with the extraction script, capture visible-area screenshots
- **Host permissions**: allow analysis on any website

## 5. Changes

Any updates to this policy will be posted on this page. Continued use of the extension constitutes acceptance.

## 6. Contact

For privacy questions, contact: [your email]
