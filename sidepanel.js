// StyleLens Side Panel —— 渲染 + 复制 + 导出
// 从统一数据对象渲染（见产品设计文档 §5.2）：
//   tokens 阶段 1 立即可用，analysis 阶段 2 热更新（淡入）

const $ = id => document.getElementById(id);

const state = {
  data: null,      // 阶段 1 提取结果
  analysis: null,  // 阶段 2 AI 解读，无 Key 时始终为 null
  hasKey: false,
  ai: { status: 'idle', error: '' } // idle | running | done | error（AI 状态机）
};

let toastTimer = null;
let aiWatchdog = null;      // AI 超时看门狗
let aiKeepalive = null;     // AI 生成期间保持开放的 port，防止 Service Worker 被终止
const AI_TIMEOUT_MS = 95000; // 与 background 的空闲超时（90s 无新数据）对齐，加 5s 余量

init();

async function init() {
  bindEvents();
  analyze(); // 打开面板即自动分析当前页

  // 设置页保存 AI 配置后自动重新分析，无需手动刷新面板
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const aiKeys = ['provider', 'anthropicKey', 'claudeApiKey', 'openaiBaseUrl', 'openaiKey', 'openaiModel'];
    if (aiKeys.some(k => changes[k])) analyze();
  });
}

function bindEvents() {
  $('reanalyzeBtn').addEventListener('click', analyze);
  $('retryBtn').addEventListener('click', analyze);
  $('exportBtn').addEventListener('click', exportMD);
  $('unlockCard').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });
  // 设置入口：无论是否已配置 Key 都可随时编辑
  $('settingsBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });
  $('aiRetryBtn').addEventListener('click', analyze);
  $('aiSettingsBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });

  // 全量可复制：token 行 / 色块 / 字体行 整行可点击（事件委托）
  document.addEventListener('click', e => {
    const target = e.target.closest('[data-css]');
    if (target) copyCss(target.dataset.css, target.dataset.color || null);
  });

  // 折叠/展开（事件委托）
  document.addEventListener('click', e => {
    const header = e.target.closest('.detail-group-header');
    if (!header) return;
    const content = header.nextElementSibling;
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'block' : 'none';
    header.classList.toggle('collapsed', !isHidden);
  });
}

/* ===== 来自 background 的消息 ===== */

chrome.runtime.onMessage.addListener(msg => {
  if (!msg || !msg.type) return;
  if (msg.type === 'TRIGGER_ANALYZE') analyze();
  if (msg.type === 'AI_START') {
    setStep('step3', 'active');
    openAIKeepalive();
    setAIStatus('running');
  }
  if (msg.type === 'AI_PROGRESS') {
    // 有新数据流入：重置看门狗，只要 token 持续返回就不超时
    if (state.ai.status === 'running') startAIWatchdog();
  }
  if (msg.type === 'AI_DONE') {
    closeAIKeepalive();
    state.analysis = msg.analysis;
    setAIStatus('done');
  }
  if (msg.type === 'AI_ERROR') {
    closeAIKeepalive();
    setStep('step3', 'error');
    setAIStatus('error', msg.error || 'AI 解读失败');
  }
});

/* ===== 分析流程 ===== */

async function analyze() {
  // 新分析开始：先重置数据与 AI 状态机
  //（ANALYZE 发出后 AI 消息才可能到达，此处重置不会覆盖先到的消息）
  state.analysis = null;
  clearAIWatchdog();
  closeAIKeepalive();
  state.ai = { status: 'idle', error: '', notStartedReason: '' };

  setView('loading');
  setStep('step1', 'active');
  setStep('step2', 'pending');
  setStep('step3', 'pending');
  $('earlyPalette').hidden = true;

  const res = await chrome.runtime.sendMessage({ type: 'ANALYZE' });

  if (!res || !res.ok) {
    showError((res && res.error) || '分析失败，请重试');
    return;
  }

  state.data = res.data;
  state.hasKey = res.hasKey;

  // 阶段 1 完成：色板先行渲染，再切结果视图
  setStep('step1', 'done');
  renderEarlyPalette(res.data);
  setStep('step2', 'active');

  await sleep(350); // 分步反馈节奏
  setStep('step2', 'done');
  setStep('step3', res.hasKey ? 'active' : 'pending');

  renderResult();
  setView('result');

  // 仅当 background 确认 AI 已启动（有 KEY 且有截图）才进入 running；
  // 若 AI 消息已先到达（快失败），renderAI 已渲染对应状态，不再覆盖
  if (res.aiStarted && state.ai.status === 'idle') {
    openAIKeepalive();
    setAIStatus('running');
  } else if (!res.aiStarted && state.ai.status === 'idle') {
    // AI 未启动：标记 step3 并记录具体原因（截图失败/未配置），避免永久 pending
    setStep('step3', 'error');
    state.ai.notStartedReason = res.hasKey
      ? `页面截图失败：${res.screenshotError || '未知原因'}。请重试；若持续失败，请到 chrome://extensions 重新加载本扩展。`
      : '';
  }
}

// Loading 期间色板先行渲染
function renderEarlyPalette(d) {
  const colors = ((d.tokens || {}).colors || []).slice(0, 8);
  if (!colors.length) return;
  $('earlyPaletteRow').innerHTML = colors.map(c =>
    `<div class="color-swatch" style="background: ${esc(c.value)};"></div>`).join('');
  $('earlyPalette').hidden = false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function showError(text) {
  $('errorText').textContent = text;
  setView('error');
}

function setView(name) {
  const panel = $('sidePanel');
  panel.classList.remove('show-empty', 'show-loading', 'show-error', 'show-result');
  panel.classList.add('show-' + name);
}

function setStep(id, cls) {
  $(id).className = 'loading-step ' + cls;
}

/* ===== 渲染（阶段 1） ===== */

function renderResult() {
  const d = state.data;
  if (!d) return;

  $('panelUrl').textContent = hostOf(d.url);
  $('moodTitle').textContent = (d.title || hostOf(d.url)) + ' — 设计语言速览';

  // Mood Board 自适应：背景 = 目标站主背景色，文字色按亮度计算
  const board = $('moodBoard');
  const bg = d.dominantBgColor || '#FFFFFF';
  board.style.background = bg;
  board.style.color = luminance(bg) > 0.5 ? '#1a1a1a' : '#ffffff';

  // 色板
  const colors = (d.tokens && d.tokens.colors) || [];
  $('moodPalette').innerHTML = colors.map(c => `
    <div class="color-swatch" style="background: ${esc(c.value)};"
         data-css="${esc(c.css)}" data-color="${esc(c.value)}">
      <span class="tooltip">${esc(c.value)} ${esc(c.name)}</span>
    </div>`).join('');

  // 字体实际渲染预览（取首个标题级 + 正文）
  const typo = (d.tokens && d.tokens.typography) || [];
  const heading = typo.find(t => /^H1|^H2/.test(t.level));
  const body = typo.find(t => t.level === '正文') || typo[0];
  const preview = [heading, body].filter(Boolean);
  $('fontPreview').hidden = preview.length === 0;
  $('fontSamples').innerHTML = preview.map(t => `
    <div class="font-sample" data-css="${esc(t.css)}">
      <div class="name">${esc(t.level)} — ${esc(t.family)} / ${esc(t.weight)} / ${esc(t.size)}</div>
      <div class="text" style="font-family: ${esc(t.family)}, sans-serif; font-weight: ${esc(t.weight)};">
        ${esc(d.title || 'AaBbCc 设计基因')}
      </div>
    </div>`).join('');

  // AI 区域：先清空上一轮内容，再统一交给 AI 状态机渲染（防残留与竞态）
  $('aiZone').hidden = true;
  $('aiZone').classList.remove('fade-in');
  $('moodIntent').hidden = true;
  renderAI();

  // 详细规范折叠卡片组
  renderDetails(d);
}

function renderDetails(d) {
  const t = d.tokens || {};
  const groups = [];

  if (t.colors && t.colors.length) {
    groups.push({
      title: '颜色体系',
      summary: t.colors.length + ' 个核心色',
      rows: t.colors.map(c => ({
        color: c.value, label: c.name, value: c.value, css: c.css, colorHex: c.value
      }))
    });
  }

  if (t.typography && t.typography.length) {
    groups.push({
      title: '字体体系',
      summary: [...new Set(t.typography.map(x => x.family))].slice(0, 2).join(' / '),
      rows: t.typography.map(x => ({
        label: x.level, value: `${x.family} · ${x.weight} · ${x.size}`, css: x.css
      }))
    });
  }

  if (t.spacing && t.spacing.length) {
    groups.push({
      title: '间距体系',
      summary: '基础单元 ' + t.spacing[0].value,
      rows: t.spacing.map(x => ({ label: x.name, value: x.value, css: x.css }))
    });
  }

  const radiusShadows = [...(t.radius || []), ...(t.shadows || [])];
  if (radiusShadows.length) {
    groups.push({
      title: '圆角与阴影',
      summary: radiusShadows.map(x => x.value).slice(0, 3).join(' / '),
      rows: radiusShadows.map(x => ({ label: x.name, value: x.value, css: x.css }))
    });
  }

  const layout = d.layout || {};
  const layoutRows = [];
  if (layout.maxWidth) layoutRows.push({ label: 'Max Width', value: layout.maxWidth, css: `max-width: ${layout.maxWidth};` });
  if (layout.mode) layoutRows.push({ label: '布局模式', value: layout.mode, css: `display: ${layout.mode};` });
  if (layout.breakpoints && layout.breakpoints.length) {
    layoutRows.push({
      label: '断点',
      value: layout.breakpoints.map(b => parseInt(b, 10)).join(' / '),
      css: `@media (min-width: ${layout.breakpoints[0]}) { }`
    });
  }
  if (layoutRows.length) {
    groups.push({
      title: '布局体系',
      summary: [layout.maxWidth, layout.mode].filter(Boolean).join(' / '),
      rows: layoutRows
    });
  }

  $('detailsSection').innerHTML = groups.map(g => `
    <div class="detail-group">
      <div class="detail-group-header">
        <span>${esc(g.title)}</span>
        <span class="summary">${esc(g.summary)}</span>
      </div>
      <div class="detail-group-content">
        ${g.rows.map(r => `
          <div class="token-row" data-css="${esc(r.css)}" ${r.colorHex ? `data-color="${esc(r.colorHex)}"` : ''}>
            ${r.color ? `<div class="token-color" style="background: ${esc(r.color)};"></div>` : ''}
            <span class="token-label">${esc(r.label)}</span>
            <span class="token-value">${esc(r.value)}</span>
            <span class="copy-hint">复制</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

/* ===== 渲染（阶段 2：AI 热更新，淡入） ===== */

function applyAI() {
  const a = state.analysis;
  if (!a) return;

  $('aiSkeleton').hidden = true;
  $('aiErrorCard').hidden = true;
  setStep('step3', 'done');

  if (a.tags && a.tags.length) {
    $('styleTags').innerHTML = a.tags.map(t => `<span class="tag">#${esc(String(t).replace(/^#/, ''))}</span>`).join('');
    $('aiZone').hidden = false;
    $('aiZone').classList.remove('fade-in');
    void $('aiZone').offsetWidth; // 重置动画
    $('aiZone').classList.add('fade-in');
  }

  if (a.intent) {
    $('moodIntent').textContent = '"' + a.intent + '"';
    $('moodIntent').hidden = false;
  }

  $('unlockCard').hidden = true;
}

/* ===== AI 状态机：统一处理 AI_START / AI_DONE / AI_ERROR 与渲染竞态 ===== */

function setAIStatus(status, error) {
  state.ai.status = status;
  if (error != null) state.ai.error = error;
  if (status === 'running') startAIWatchdog();
  if (status === 'done' || status === 'error') clearAIWatchdog();
  renderAI();
}

// 按状态机渲染 AI 区域（骨架屏 / 结果 / 错误卡 / 解锁引导），渲染竞态安全
function renderAI() {
  const st = state.ai.status;

  if (st === 'done' && state.analysis) {
    $('aiSkeleton').hidden = true;
    $('aiErrorCard').hidden = true;
    applyAI();
    return;
  }

  if (st === 'error') {
    $('aiSkeleton').hidden = true;
    $('unlockCard').hidden = true;
    $('aiErrorDetail').textContent = state.ai.error || 'AI 解读失败';
    $('aiErrorCard').hidden = false;
    return;
  }

  if (st === 'running') {
    $('aiErrorCard').hidden = true;
    $('unlockCard').hidden = true;
    $('aiSkeleton').hidden = false;
    return;
  }

  // idle：无 KEY 显示解锁引导；有 KEY 但 AI 未启动（如截图失败）给出明确提示
  $('aiSkeleton').hidden = true;
  $('aiErrorCard').hidden = true;
  if (state.hasKey) {
    $('unlockCard').hidden = true;
    $('aiErrorDetail').textContent = state.ai.notStartedReason ||
      '本次分析未获取到页面截图，AI 解读未启动。点击重试；若持续失败，请到 chrome://extensions 重新加载本扩展。';
    $('aiErrorCard').hidden = false;
  } else {
    $('unlockCard').hidden = false;
  }
}

// 看门狗：background 异常挂起/被终止时，保证面板不会永久 loading
//（AI_PROGRESS 到达时会重新计时，只有真正无响应才会触发）
function startAIWatchdog() {
  clearAIWatchdog();
  aiWatchdog = setTimeout(() => {
    if (state.ai.status === 'running') {
      closeAIKeepalive();
      setStep('step3', 'error');
      setAIStatus('error', 'AI 长时间无响应，请检查网络或更换更快的模型后重试');
    }
  }, AI_TIMEOUT_MS);
}

function clearAIWatchdog() {
  clearTimeout(aiWatchdog);
  aiWatchdog = null;
}

// keepalive：AI 生成期间保持与 Service Worker 的开放连接，
// 防止 SW 在 60~90s 的长流式请求中被 Chrome 终止（终止后 AI_DONE/ERROR 永远无法送达）
function openAIKeepalive() {
  closeAIKeepalive();
  try {
    aiKeepalive = chrome.runtime.connect({ name: 'ai-keepalive' });
    aiKeepalive.onDisconnect.addListener(() => { aiKeepalive = null; });
  } catch { aiKeepalive = null; }
}

function closeAIKeepalive() {
  if (aiKeepalive) {
    try { aiKeepalive.disconnect(); } catch {}
    aiKeepalive = null;
  }
}

/* ===== 全量可复制 + Toast ===== */

function copyCss(css, colorHex) {
  if (!css) return;
  navigator.clipboard.writeText(css).catch(() => {});
  showToast('✓ 已复制 ' + css, colorHex);
}

function showToast(text, colorHex) {
  const toast = $('toast');
  // 背景色 = 当前复制的颜色值；非颜色类用品牌紫
  const useColor = colorHex && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colorHex) &&
                   colorHex.toLowerCase() !== '#ffffff';
  toast.style.background = useColor ? colorHex : '#6366f1';
  toast.style.color = useColor && luminance(colorHex) > 0.5 ? '#1a1a1a' : '#ffffff';
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 800); // 0.8s 自动消失
}

/* ===== 导出 MD（与展示同源；无 Key 不含 AI 解读） ===== */

function exportMD() {
  const d = state.data;
  if (!d) {
    showToast('暂无分析结果', null);
    return;
  }
  const a = state.analysis;
  const withAI = !!a;
  const t = d.tokens || {};
  const layout = d.layout || {};
  const host = hostOf(d.url);
  const date = new Date().toISOString().split('T')[0];

  let md = `<!-- 本文件由 StyleLens 自动生成，可直接作为 AI 编程助手的设计约束使用 -->
<!-- 使用方式：将本文件放入项目根目录，在 prompt 中引用即可 -->

${[
    `# ${host} 设计规范`,
    withAI && a.intent ? `> ${a.intent}` : '> （配置 API Key 后可生成一句话设计意图概述）',
    withAI && a.tags && a.tags.length
      ? '**风格标签：** ' + a.tags.map(t2 => '#' + String(t2).replace(/^#/, '')).join(' ')
      : null
  ].filter(Boolean).join('\n\n')}

---
`;

  if (withAI && a.detail) {
    md += `
## 设计意图

${a.detail}
`;
  }

  md += `
## Design Tokens

### 颜色体系

| 用途 | 色值 | CSS 声明 |
|------|------|----------|
${(t.colors || []).map(c => `| ${c.name} | ${c.value} | \`${c.css}\` |`).join('\n')}

### 字体体系

| 层级 | 字体 | 字号 | 字重 | CSS 声明 |
|------|------|------|------|----------|
${(t.typography || []).map(x => `| ${x.level} | ${x.family} | ${x.size} | ${x.weight} | \`${x.css}\` |`).join('\n')}

### 间距体系

| 用途 | 值 | CSS 声明 |
|------|-----|----------|
${(t.spacing || []).map(x => `| ${x.name} | ${x.value} | \`${x.css}\` |`).join('\n')}

### 圆角与阴影

| 用途 | 值 | CSS 声明 |
|------|-----|----------|
${[...(t.radius || []), ...(t.shadows || [])].map(x => `| ${x.name} | ${x.value} | \`${x.css}\` |`).join('\n')}

## 布局体系

| 属性 | 值 | CSS 声明 |
|------|-----|----------|
${layout.maxWidth ? `| 最大宽度 | ${layout.maxWidth} | \`max-width: ${layout.maxWidth};\` |\n` : ''}${layout.mode ? `| 布局模式 | ${layout.mode} | \`display: ${layout.mode};\` |\n` : ''}${layout.breakpoints && layout.breakpoints.length ? `| 断点 | ${layout.breakpoints.map(b => parseInt(b, 10)).join('/')} | \`@media (min-width: ${layout.breakpoints[0]})\` |` : ''}
`;

  if (withAI && a.agentSuggestions) {
    const s = a.agentSuggestions;
    md += `
## 给 AI Agent 的指令建议

### Tailwind CSS 配置参考

\`\`\`js
// tailwind.config.js extend 建议
${typeof s === 'string' ? s : (s.tailwind || JSON.stringify(s, null, 2))}
\`\`\`

### CSS 变量参考

\`\`\`css
${typeof s === 'string' ? '' : (s.css_vars || '')}
\`\`\`
`;
  }

  md += `
---

*Generated by StyleLens | ${d.url} | ${date}*
`;

  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = host + '-design-spec.md';
  link.click();
  URL.revokeObjectURL(url);
  showToast('✓ 已导出 MD', null);
}

/* ===== 工具 ===== */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}

function luminance(hex) {
  const n = String(hex).replace('#', '');
  if (n.length < 6) return 1;
  const r = parseInt(n.substr(0, 2), 16) / 255;
  const g = parseInt(n.substr(2, 2), 16) / 255;
  const b = parseInt(n.substr(4, 2), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
