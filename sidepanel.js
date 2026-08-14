// StyleLens Side Panel —— 渲染 + 复制 + 导出
// 从统一数据对象渲染（见产品设计文档 §5.2）：
//   tokens 阶段 1 立即可用，analysis 阶段 2 热更新（淡入）

const $ = id => document.getElementById(id);

const state = {
  data: null,      // 阶段 1 提取结果
  analysis: null,  // 阶段 2 AI 解读，无 Key 时始终为 null
  hasKey: false
};

let toastTimer = null;

init();

async function init() {
  bindEvents();
  analyze(); // 打开面板即自动分析当前页
}

function bindEvents() {
  $('reanalyzeBtn').addEventListener('click', analyze);
  $('retryBtn').addEventListener('click', analyze);
  $('exportBtn').addEventListener('click', exportMD);
  $('unlockCard').addEventListener('click', () => {
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
    $('aiSkeleton').hidden = false;
    setStep('step3', 'active');
  }
  if (msg.type === 'AI_DONE') {
    state.analysis = msg.analysis;
    applyAI();
  }
  if (msg.type === 'AI_ERROR') {
    $('aiSkeleton').hidden = true;
    showToast('AI 解读失败：' + msg.error, null);
  }
});

/* ===== 分析流程 ===== */

async function analyze() {
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
  state.analysis = null;
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

  if (res.hasKey) {
    $('aiSkeleton').hidden = false;
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

  // AI 区域重置
  $('aiZone').hidden = true;
  $('aiZone').classList.remove('fade-in');
  $('moodIntent').hidden = true;
  $('aiSkeleton').hidden = true;
  $('unlockCard').hidden = state.hasKey; // 无 Key：引导卡片

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
