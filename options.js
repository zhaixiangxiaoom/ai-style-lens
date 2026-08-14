// StyleLens Options —— 多供应商 AI 配置（chrome.storage.sync，跨设备同步）

const $ = id => document.getElementById(id);

// 常见供应商预设：Base URL + 推荐视觉模型
const PRESETS = {
  openai:     { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  moonshot:   { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
  qwen:       { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
  zhipu:      { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' }
};

let provider = 'anthropic';

init();

async function init() {
  // 回显（兼容旧版单 Key 存储 claudeApiKey）
  const s = await chrome.storage.sync.get([
    'provider', 'anthropicKey', 'claudeApiKey',
    'openaiBaseUrl', 'openaiKey', 'openaiModel'
  ]);
  $('anthropicKey').value = s.anthropicKey || s.claudeApiKey || '';
  $('openaiBaseUrl').value = s.openaiBaseUrl || '';
  $('openaiKey').value = s.openaiKey || '';
  $('openaiModel').value = s.openaiModel || '';

  // 根据已保存的 Base URL 反推预设下拉（无匹配则为“自定义”）
  $('preset').value = matchPreset(s.openaiBaseUrl || '');

  setProvider(s.provider === 'openai' ? 'openai' : 'anthropic');

  $('provAnthropic').addEventListener('click', () => setProvider('anthropic'));
  $('provOpenai').addEventListener('click', () => setProvider('openai'));

  $('preset').addEventListener('change', e => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    $('openaiBaseUrl').value = p.baseUrl;
    $('openaiModel').value = p.model;
  });

  // 手动改 Base URL 时同步预设下拉（匹配到预设则选中，否则回到自定义）
  $('openaiBaseUrl').addEventListener('change', e => {
    $('preset').value = matchPreset(e.target.value);
  });

  $('saveBtn').addEventListener('click', save);
  $('testBtn').addEventListener('click', test);
  $('clearBtn').addEventListener('click', clear);
}

function setProvider(p) {
  provider = p;
  $('provAnthropic').classList.toggle('active', p === 'anthropic');
  $('provOpenai').classList.toggle('active', p === 'openai');
  $('secAnthropic').hidden = p !== 'anthropic';
  $('secOpenai').hidden = p !== 'openai';
}

// Base URL 反推预设 key（忽略尾部斜杠；无匹配返回 'custom'）
function matchPreset(url) {
  const norm = String(url).trim().replace(/\/+$/, '');
  const hit = Object.entries(PRESETS).find(([, p]) => p.baseUrl.replace(/\/+$/, '') === norm);
  return hit ? hit[0] : 'custom';
}

async function save() {
  if (provider === 'anthropic' && !$('anthropicKey').value.trim()) {
    return showStatus('请输入 Claude API Key', true);
  }
  if (provider === 'openai') {
    if (!$('openaiKey').value.trim()) return showStatus('请输入 API Key', true);
    if (!$('openaiModel').value.trim()) return showStatus('请填写模型名称', true);
  }

  await chrome.storage.sync.set({
    provider,
    anthropicKey: $('anthropicKey').value.trim(),
    openaiBaseUrl: $('openaiBaseUrl').value.trim(),
    openaiKey: $('openaiKey').value.trim(),
    openaiModel: $('openaiModel').value.trim()
  });
  showStatus('✓ 已保存，AI 设计解读已解锁', false);
}

async function test() {
  showStatus('测试中...', false);
  const res = await chrome.runtime.sendMessage({ type: 'TEST_AI' });
  if (res && res.ok) {
    showStatus('✓ 连接成功', false);
  } else {
    showStatus('✗ 连接失败：' + ((res && res.error) || '未知错误'), true);
  }
}

async function clear() {
  ['anthropicKey', 'openaiKey', 'openaiModel', 'openaiBaseUrl'].forEach(id => { $(id).value = ''; });
  await chrome.storage.sync.remove([
    'claudeApiKey', 'anthropicKey', 'openaiKey', 'openaiModel', 'openaiBaseUrl'
  ]);
  showStatus('已清除，回到无 Key 基础模式', false);
}

function showStatus(text, isError) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  if (!isError) setTimeout(() => { el.textContent = ''; }, 3000);
}
