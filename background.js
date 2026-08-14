// StyleLens background Service Worker —— 消息中转 + AI API 调用（多供应商）
// 双阶段架构（见产品设计文档 §5.1）：
//   阶段 1：content.js 提取 → 立即回传 sidepanel 渲染（无需 Key）
//   阶段 2：截图 + 结构化数据 → Anthropic / OpenAI 兼容协议 (Streaming) → AI_DONE 热更新

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

/* ===== 触发入口：图标点击 / 快捷键 ===== */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'analyze') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
  chrome.runtime.sendMessage({ type: 'TRIGGER_ANALYZE' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'ANALYZE') {
    handleAnalyze().then(sendResponse);
    return true; // 异步响应
  }
  if (msg && msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
  }
  if (msg && msg.type === 'TEST_AI') {
    testAI().then(sendResponse);
    return true;
  }
  return false;
});

// 面板在 AI 生成期间保持开放连接：防止 Service Worker 在长流式请求中被终止
chrome.runtime.onConnect.addListener(() => {});

/* ===== 阶段 1：提取 + 截图 ===== */

async function handleAnalyze() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    return { ok: false, error: '当前页面不支持分析（仅 http/https 页面可用）' };
  }
  try {
    // 按需注入 content script（重复注入由 content.js 内部守卫）
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'STYLELENS_EXTRACT' });
    if (!resp || !resp.ok) {
      return { ok: false, error: (resp && resp.error) || '提取设计元素失败' };
    }

    let screenshot = null;
    let screenshotError = '';
    try {
      screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 });
    } catch (err) {
      // 截图失败不阻塞阶段 1，但记录原因便于 AI 未启动时诊断
      screenshotError = String((err && err.message) || err);
    }

    const cfg = await getAIConfig();
    const hasKey = aiReady(cfg);
    const aiStarted = hasKey && !!screenshot;

    // 阶段 2：已配置且有截图时异步启动，不阻塞阶段 1 返回
    if (aiStarted) runAI(cfg, resp.data, screenshot);

    return { ok: true, data: resp.data, screenshot, hasKey, aiStarted, screenshotError };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* ===== AI 配置（多供应商，兼容旧版单 Key 存储） ===== */

async function getAIConfig() {
  const s = await chrome.storage.sync.get([
    'provider', 'anthropicKey', 'claudeApiKey',
    'openaiBaseUrl', 'openaiKey', 'openaiModel'
  ]);
  return {
    provider: s.provider === 'openai' ? 'openai' : 'anthropic',
    anthropicKey: s.anthropicKey || s.claudeApiKey || '',
    openaiBaseUrl: (s.openaiBaseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, ''),
    openaiKey: s.openaiKey || '',
    openaiModel: (s.openaiModel || '').trim()
  };
}

function aiReady(cfg) {
  return cfg.provider === 'anthropic'
    ? !!cfg.anthropicKey
    : !!(cfg.openaiKey && cfg.openaiModel);
}

/* ===== 阶段 2：按供应商分发（Streaming + 空闲超时控制，避免面板永久 loading） ===== */

// 无数据超时：持续无新数据超过该时长才中止。
// 不用固定总时长：VL 模型全量解读需 60~90s，只要 token 在持续流式返回就应继续等待
const AI_IDLE_TIMEOUT_MS = 90000;

async function runAI(cfg, data, screenshot) {
  chrome.runtime.sendMessage({ type: 'AI_START' }).catch(() => {});
  try {
    const image = await prepareImage(screenshot);
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), AI_IDLE_TIMEOUT_MS);
    // 每收到数据重置空闲计时，并通知面板重置看门狗（同时保活 SW）
    const onProgress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), AI_IDLE_TIMEOUT_MS);
      chrome.runtime.sendMessage({ type: 'AI_PROGRESS' }).catch(() => {});
    };
    const text = cfg.provider === 'anthropic'
      ? await callAnthropic(cfg, data, image, controller.signal, onProgress)
      : await callOpenAI(cfg, data, image, controller.signal, onProgress);
    clearTimeout(timer);
    chrome.runtime.sendMessage({ type: 'AI_DONE', analysis: parseAnalysis(text) }).catch(() => {});
  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'AI_ERROR',
      error: (err && err.name === 'AbortError')
        ? `AI 长时间无响应（${AI_IDLE_TIMEOUT_MS / 1000}s 无新数据），请检查网络或更换更快的模型后重试`
        : String((err && err.message) || err)
    }).catch(() => {});
  }
}

// Anthropic 原生协议
async function callAnthropic(cfg, data, image, signal, onProgress) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: buildUserPrompt(data) }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
          text += ev.delta.text;
          onProgress();
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
  }
  return text;
}

// OpenAI 兼容协议（OpenAI / Kimi / Qwen / GLM / OpenRouter / 自建服务等）
async function callOpenAI(cfg, data, image, signal, onProgress) {
  const res = await fetch(cfg.openaiBaseUrl + '/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.openaiKey}`
    },
    body: JSON.stringify({
      model: cfg.openaiModel,
      max_tokens: 4000,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
          { type: 'text', text: buildUserPrompt(data) }
        ] }
      ]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const ctype = res.headers.get('content-type') || '';
  // 部分兼容服务不支持流式 → 整包 JSON 解析
  if (ctype.includes('application/json')) {
    const json = await res.json();
    onProgress();
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  }

  // SSE 流式
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (delta && delta.content) {
          text += delta.content;
          onProgress();
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
  }
  return text;
}

// 连接测试（options 页调用）
async function testAI() {
  const cfg = await getAIConfig();
  if (!aiReady(cfg)) return { ok: false, error: '请先完整填写配置（Key / 模型）' };
  try {
    const res = cfg.provider === 'anthropic'
      ? await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' }
        })
      : await fetch(cfg.openaiBaseUrl + '/models', {
          headers: { authorization: `Bearer ${cfg.openaiKey}` }
        });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// 解析模型输出的 JSON（容忍 ```json 代码块包裹）
function parseAnalysis(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出格式异常');
  const obj = JSON.parse(raw.slice(start, end + 1));
  return {
    tags: Array.isArray(obj.style_tags) ? obj.style_tags.slice(0, 3) : [],
    intent: obj.summary || '',
    detail: obj.intent || '',
    agentSuggestions: obj.agent_instructions || null
  };
}

// 截图缩放到 Claude 图像限制内（最大边 1568px）
async function prepareImage(dataUrl) {
  const MAX = 1568;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    let out = blob;
    if (scale < 1) {
      const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    }
    return { base64: await blobToBase64(out), mediaType: 'image/jpeg' };
  } catch {
    // 降级：原图直传
    return { base64: dataUrl.split(',')[1] || '', mediaType: 'image/jpeg' };
  }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* ===== Prompt 设计（见产品设计文档 §6，三段式） ===== */

const SYSTEM_PROMPT = `你是一位资深 UI/UX 设计分析师。根据提供的网站截图和结构化设计数据，
分析该网站的设计语言并输出标准格式的设计规范文档。
你的分析应兼顾：设计意图解读（WHY）和精确数值记录（WHAT）。
解读必须有洞察力：回答“这些数值组合产生了什么视觉效果与意图”，
严禁复述页面标题、产品定位或功能描述——那不是设计解读。`;

function buildUserPrompt(data) {
  const structured = {
    tokens: data.tokens,
    layout: data.layout,
    dominantBgColor: data.dominantBgColor
  };
  return `## 网站信息
- URL: ${data.url}
- 标题: ${data.title}

## 提取的设计数据
${JSON.stringify(structured, null, 2)}

## 页面截图
见附图

请基于以上信息，生成该网站的设计规范。

请按以下结构输出 JSON（只输出 JSON，不要其他内容）：

1. style_tags: 2-3个风格标签，必须源自视觉特征（如“高留白”“胶囊语言”“深色模式”），禁用行业泛称
2. summary: 一句话视觉性格概述。必须基于视觉证据（色彩占比、留白密度、圆角语言、对比关系），
   严禁复述网站标题、产品定位或目标人群。
   反例：“面向 GenZ 创业者的轻量级社交平台。”（这是产品描述，不是设计解读）
   正例：“以中性灰白为底、极高留白占比，仅保留单一品牌蓝作为高饱和焦点，用工具感的克制包裹社区温度。”
3. intent: 设计意图解读段落（100-200 字），必须引用至少 3 个具体数值证据
   （如主色占比、圆角值、间距节奏、字号对比），并解释它们带来的用户感知
4. design_tokens:
   - colors: [{name, value, role, css_property}]
   - typography: [{level, family, size, weight, css}]
   - spacing: [{name, value, css}]
   - border_radius: [{name, value, css}]
   - shadows: [{name, value, css}]
5. layout: {max_width, mode, breakpoints, css}
6. agent_instructions: 给 AI 编程助手的复现指令，包含两个字段：
   - tailwind: tailwind.config.js 的 extend 配置代码
   - css_vars: :root CSS 变量定义代码

注意：每个 token 必须包含 css 字段，值为可直接使用的完整 CSS 声明（如 "color: #635BFF;"）。`;
}
