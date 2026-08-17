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

  // 导出菜单：点击展开，选中即导出，点外部自动收起
  $('exportBtn').addEventListener('click', e => {
    e.stopPropagation();
    $('exportMenu').hidden = !$('exportMenu').hidden;
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.export-wrap')) $('exportMenu').hidden = true;
  });
  $('exportMenu').addEventListener('click', e => {
    const btn = e.target.closest('[data-export]');
    if (btn) doExport(btn.dataset.export);
  });

  // 历史库入口与清空
  $('historyBtn').addEventListener('click', showHistory);
  $('historyClearBtn').addEventListener('click', async () => {
    await chrome.storage.local.remove(HISTORY_KEY);
    showHistory();
  });
  $('historyList').addEventListener('click', e => {
    const item = e.target.closest('.history-item');
    if (item) openHistoryEntry(item.dataset.url);
  });
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
    resetLive();
    setAIStatus('running');
  }
  if (msg.type === 'AI_PROGRESS') {
    // 有新数据流入：重置看门狗 + 流式渲染已到达字段
    if (state.ai.status === 'running') {
      startAIWatchdog();
      renderLive(msg.partial);
    }
  }
  if (msg.type === 'AI_DONE') {
    closeAIKeepalive();
    state.analysis = msg.analysis;
    if (state.data) updateHistoryAnalysis(state.data.url, msg.analysis);
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
  resetLive();
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
  saveHistoryEntry(res.data); // 自动存入历史库，离线可回看

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
  panel.classList.remove('show-empty', 'show-loading', 'show-error', 'show-result', 'show-history');
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

  download(host + '-design-spec.md', md, 'text/markdown');
  showToast('✓ 已导出 MD', null);
}

/* ===== AI 流式预览（background 节流推送的部分字段，逐字渲染） ===== */

function resetLive() {
  $('aiLiveTags').innerHTML = '';
  $('aiLiveText').textContent = '';
  $('aiLiveText').hidden = true;
}

function renderLive(p) {
  if (!p) return;
  if (p.tags && p.tags.length) {
    $('aiLiveTags').innerHTML = p.tags.map(t =>
      `<span class="tag">#${esc(String(t).replace(/^#/, ''))}</span>`).join('');
  }
  const text = [p.summary, p.intent].filter(Boolean).join('\n\n');
  if (text) {
    $('aiLiveText').hidden = false;
    $('aiLiveText').textContent = text;
  } else if (p.thinking) {
    // 思考模型（qwen3 等）reasoning 阶段：content 尚未开始，给出可见反馈
    $('aiLiveText').hidden = false;
    $('aiLiveText').textContent = '模型正在思考…';
  }
}

/* ===== 历史库（chrome.storage.local，离线可回看） ===== */

const HISTORY_KEY = 'history';
const HISTORY_MAX = 20;

async function loadHistory() {
  const s = await chrome.storage.local.get(HISTORY_KEY);
  return s[HISTORY_KEY] || [];
}

async function saveHistoryEntry(data) {
  const list = await loadHistory();
  const entry = {
    url: data.url, title: data.title, host: hostOf(data.url),
    savedAt: Date.now(), data, analysis: state.analysis
  };
  const next = [entry, ...list.filter(e => e.url !== data.url)].slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

async function updateHistoryAnalysis(url, analysis) {
  const list = await loadHistory();
  const entry = list.find(e => e.url === url);
  if (!entry) return;
  entry.analysis = analysis;
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
}

async function showHistory() {
  const list = await loadHistory();
  $('historyList').innerHTML = list.length ? list.map(e => `
    <div class="history-item" data-url="${esc(e.url)}">
      <div class="hi-title">${esc(e.title || e.host)}</div>
      <div class="hi-meta">${esc(e.host)} · ${timeAgo(e.savedAt)}${e.analysis ? '<span class="hi-ai">AI</span>' : ''}</div>
    </div>`).join('')
    : '<div class="history-empty">暂无历史，分析完成后自动保存到这里。</div>';
  setView('history');
}

async function openHistoryEntry(url) {
  const list = await loadHistory();
  const entry = list.find(e => e.url === url);
  if (!entry) return;
  state.data = entry.data;
  state.analysis = entry.analysis || null;
  clearAIWatchdog();
  closeAIKeepalive();
  resetLive();
  state.ai = {
    status: entry.analysis ? 'done' : 'idle',
    error: '',
    notStartedReason: entry.analysis ? '' : '该记录生成时未配置 AI，无解读内容。点“重新分析”可为当前页生成。'
  };
  renderResult();
  setView('result');
}

function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

/* ===== 导出矩阵（MD / W3C Tokens / tailwind.config.js / Agent Prompt） ===== */

function doExport(kind) {
  const d = state.data;
  $('exportMenu').hidden = true;
  if (!d) return showToast('暂无分析结果', null);
  const host = hostOf(d.url);

  if (kind === 'md') return exportMD();
  if (kind === 'json') {
    download(`${host}-design-tokens.json`, buildW3CTokens(d), 'application/json');
    showToast('✓ 已导出 W3C Design Tokens', null);
  } else if (kind === 'tailwind') {
    download('tailwind.config.js', buildTailwindConfig(d), 'text/javascript');
    showToast('✓ 已下载 tailwind.config.js', null);
  } else if (kind === 'prompt') {
    navigator.clipboard.writeText(buildAgentPrompt(d)).catch(() => {});
    showToast('✓ 已复制 Agent Prompt', null);
  }
}

function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

const keyOf = name =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'token';

// W3C Design Tokens 格式（tr.designtokens.org）
function buildW3CTokens(d) {
  const t = d.tokens || {};
  const out = { color: {}, typography: {}, spacing: {}, borderRadius: {}, shadow: {} };
  (t.colors || []).forEach(c => { out.color[keyOf(c.name)] = { $value: c.value, $type: 'color' }; });
  (t.typography || []).forEach(x => {
    out.typography[keyOf(x.level)] = {
      $value: { fontFamily: x.family, fontSize: x.size, fontWeight: String(x.weight) },
      $type: 'typography'
    };
  });
  (t.spacing || []).forEach(x => { out.spacing[keyOf(x.name + ' ' + x.value)] = { $value: x.value, $type: 'dimension' }; });
  (t.radius || []).forEach(r => { out.borderRadius[keyOf(r.name)] = { $value: r.value, $type: 'dimension' }; });
  (t.shadows || []).forEach((s, i) => { out.shadow['shadow-' + (i + 1)] = { $value: s.value, $type: 'shadow' }; });
  return JSON.stringify(out, null, 2);
}

// 从 tokens 确定性生成 tailwind.config.js（不依赖 AI）
function buildTailwindConfig(d) {
  const t = d.tokens || {};
  const colors = {};
  (t.colors || []).forEach(c => { colors[keyOf(c.name)] = c.value; });
  const radius = {};
  (t.radius || []).forEach(r => { radius[keyOf(r.name)] = r.value; });
  const shadows = {};
  (t.shadows || []).forEach((s, i) => { shadows[i === 0 ? 'DEFAULT' : 'shadow-' + (i + 1)] = s.value; });
  const families = [...new Set((t.typography || []).map(x => x.family))];
  const cfg = {
    theme: {
      extend: {
        colors,
        borderRadius: radius,
        boxShadow: shadows,
        fontFamily: families.length ? { sans: families } : {}
      }
    }
  };
  return `// StyleLens auto-generated · ${hostOf(d.url)}\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`;
}

// Agent Prompt 包：设计规范直接嵌入对话，一键交给 Cursor / Claude Code
function buildAgentPrompt(d) {
  const a = state.analysis;
  return [
    `请按照以下设计规范，复现网站 “${d.title || hostOf(d.url)}” 的设计风格：`,
    a && a.intent ? `## 设计意图\n${a.intent}` : '',
    a && a.tags && a.tags.length
      ? `## 风格标签\n${a.tags.map(t => '#' + String(t).replace(/^#/, '')).join(' ')}` : '',
    `## Design Tokens（W3C 格式）\n${buildW3CTokens(d)}`,
    `## Tailwind extend 配置\n${buildTailwindConfig(d)}`,
    '要求：严格遵循上述颜色/字体/间距/圆角数值，不要自行引入规范中不存在的颜色或尺寸。'
  ].filter(Boolean).join('\n\n');
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
