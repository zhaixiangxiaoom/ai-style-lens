// StyleLens content script —— 设计元素提取，按需注入目标页面
// 提取策略（见产品设计文档 §4）：
//   1. CSS 变量优先：:root / [data-theme] 的 custom properties
//   2. Computed Styles 兜底：可见视口内元素采样，语义标签优先
//   3. 采样而非全量：限制样本数，避免卡主线程
//   4. 聚合降噪：频次统计 + 去重，只保留 Top-N 高频值
(() => {
  if (window.__stylelensInjected) return;
  window.__stylelensInjected = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'STYLELENS_EXTRACT') {
      try {
        sendResponse({ ok: true, data: extract() });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    }
    return true;
  });

  /* ================= 工具函数 ================= */

  const probe = document.createElement('span').style;

  function isColor(v) {
    if (!v || v === 'none' || v === 'transparent') return false;
    // var() 引用在 CSSOM 中对任何属性都“解析期合法”，必须先解析再判断
    if (/var\(/i.test(v)) return false;
    probe.color = '';
    probe.color = v;
    return probe.color !== '';
  }

  // rgb()/rgba() -> #HEX，带透明度保留 rgba 形式
  // lab()/oklab()/oklch() 等现代色函数借助 canvas 转 hex（Tailwind v4 常见）
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });

  function toHex(v) {
    if (!v) return v;
    const m = String(v).match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(parseFloat);
      const [r, g, b, a] = parts;
      if (parts.length > 3 && a < 1) return `rgba(${r},${g},${b},${a})`;
      const h = n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
      return ('#' + h(r) + h(g) + h(b)).toUpperCase();
    }
    try {
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#010101'; // 哨兵值：非法输入不会覆盖
      colorCtx.fillStyle = v;
      colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
      if (a === 0) return String(v).toUpperCase();
      const h = n => n.toString(16).padStart(2, '0');
      return ('#' + h(r) + h(g) + h(b)).toUpperCase();
    } catch {
      return String(v).toUpperCase();
    }
  }

  function isTransparent(v) {
    return !v || v === 'transparent' || /rgba?\([^)]*,\s*0\s*\)/.test(v);
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  // 只取可见视口内元素，限制样本数避免卡主线程
  function collectSamples(limit = 400) {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (out.length >= limit) break;
      if (isVisible(el)) out.push(el);
    }
    return out;
  }

  function walkRules(rules, visit) {
    for (const rule of rules) {
      visit(rule);
      if (rule.cssRules && rule.cssRules.length) walkRules(rule.cssRules, visit);
    }
  }

  function safeRules(sheet) {
    try { return sheet.cssRules; } catch { return null; } // 跨域样式表跳过
  }

  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  // —— 浮层 widget 检测 ——
  // 第三方浏览器扩展注入的聊天窗/购物助手几乎必是：fixed/sticky、高 z-index、宽 < 70% 视口；
  // 它们的主题色不属于页面视觉语言，用色统计时整棵剪除
  const widgetRoots = (() => {
    let roots = null;
    return () => {
      if (roots) return roots;
      roots = [];
      let n = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (++n > 3000) break;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (parseInt(cs.zIndex, 10) < 1000) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.width >= innerWidth * 0.7) continue; // 全宽 fixed 元素（导航等）属于页面本体
        roots.push(el);
      }
      return roots;
    };
  })();
  const inWidget = el => widgetRoots().some(r => r === el || r.contains(el));

  /* ================= 颜色 ================= */

  // 1) CSS 变量优先（var() 引用递归解析后再判断颜色，避免字体等非色变量混入）
  function extractCssVarColors() {
    const vars = new Map();
    for (const sheet of document.styleSheets) {
      // 跳过浏览器扩展注入的样式表，避免第三方插件主题变量（如 jjext-*）污染页面色体系
      if (/^(chrome|moz)-extension:/.test(sheet.href || '')) continue;
      const rules = safeRules(sheet);
      if (!rules) continue;
      walkRules(rules, rule => {
        if (!rule.style || !rule.selectorText) return;
        if (!/(^|[,}\s])(:root|\[data-theme[^\]]*\])/.test(rule.selectorText)) return;
        for (const prop of rule.style) {
          if (prop.startsWith('--')) {
            vars.set(prop, rule.style.getPropertyValue(prop).trim());
          }
        }
      });
    }
    const resolve = (v, depth) => {
      const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v || '');
      if (!m || depth >= 3) return v;
      return resolve(vars.get(m[1]) || (m[2] || '').trim() || v, depth + 1);
    };
    const list = [];
    const seen = new Set();
    const rootCs = getComputedStyle(document.documentElement);
    for (const [prop, raw] of vars) {
      // 真实级联值为准：多个内联表重复声明同一变量（插件注入常见）时，样式表遍历顺序可能与级联结果不一致
      const resolved = rootCs.getPropertyValue(prop).trim() || resolve(raw, 0);
      if (!isColor(resolved)) continue;
      const value = toHex(resolved);
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const name = prop.slice(2);
      const decl = /bg|background|surface|fill/i.test(name) ? 'background-color' : 'color';
      list.push({ name, value, css: `${decl}: ${value};`, kind: decl === 'background-color' ? 'bg' : 'text' });
    }
    return list;
  }

  // 2) 页面高频色兜底（Top10）
  function extractFrequentColors(samples) {
    const freq = new Map();
    for (const el of samples) {
      if (inWidget(el)) continue; // 插件浮层不参与页面高频色统计
      const cs = getComputedStyle(el);
      const pairs = [[cs.backgroundColor, 'bg'], [cs.color, 'text']];
      for (const [raw, kind] of pairs) {
        if (isTransparent(raw)) continue;
        const value = toHex(raw);
        const key = value.toLowerCase();
        const e = freq.get(key) || { count: 0, kind, value };
        e.count++;
        freq.set(key, e);
      }
    }
    return [...freq.values()].sort((a, b) => b.count - a.count);
  }
  
  // 统计指定色值在全页 DOM 的实际使用次数（含视口外），
  // 用于识别“仅声明未使用”的 CSS 变量（如 Tailwind v4 整板调色板）
  function countColorUsage(targets) {
    const usage = new Map();
    if (!targets.size) return usage;
    const rgbOf = v => {
      const m = /^#([0-9a-f]{6})$/i.exec(v);
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    // 容差匹配：computed 的 oklch/lab 经 canvas 转 hex 后舍入差可达 ±3（Tailwind v4 常见）；
    // 容差引入的跨容器误配由 extractColors 的“容器集中度”规则兜底
    const targetList = [...targets];
    const match = hex => {
      if (targets.has(hex)) return hex;
      const a = rgbOf(hex);
      if (!a) return null;
      for (const t of targetList) {
        const b = rgbOf(t);
        if (b && Math.abs(a[0] - b[0]) <= 3 && Math.abs(a[1] - b[1]) <= 3 && Math.abs(a[2] - b[2]) <= 3) return t;
      }
      return null;
    };
    let n = 0;
    const vw = innerWidth * innerHeight || 1;
    const contCache = new Map();
    // 把元素归属到“局部容器”：最近的非 static 定位祖先，否则归到 body 直属子节点
    const containerOf = el => {
      const chain = [];
      let a = el;
      while (a && a !== document.body) {
        if (contCache.has(a)) {
          const c = contCache.get(a);
          chain.forEach(x => contCache.set(x, c));
          return c;
        }
        chain.push(a);
        if (getComputedStyle(a).position !== 'static') break;
        a = a.parentElement;
      }
      const c = (a && a !== document.body) ? a : chain[chain.length - 1];
      chain.forEach(x => contCache.set(x, c));
      return c;
    };
    const subUse = new Map(); // 色值 -> Map(容器 -> 权重)
    const exactConts = new Map(); // 色值 -> Map(容器 -> 精确命中权重)，容差命中不算
    for (const el of document.querySelectorAll('body *')) {
      if (++n > 1500) break;
      if (inWidget(el)) continue; // 插件浮层不参与页面用色统计
      // 面积加权：视觉语言由大面积色块主导，第三方插件的小 widget 拼不过页面本体
      const r = el.getBoundingClientRect();
      const w = Math.max(0.02, Math.min(1, (r.width * r.height) / vw));
      const cs = getComputedStyle(el);
      for (const raw of [cs.color, cs.backgroundColor]) {
        if (isTransparent(raw)) continue;
        const hex = toHex(raw).toLowerCase();
        const key = match(hex);
        if (!key) continue;
        usage.set(key, (usage.get(key) || 0) + w);
        const cont = containerOf(el);
        if (!cont) continue;
        if (key === hex) {
          const s = exactConts.get(key) || new Map();
          s.set(cont, (s.get(cont) || 0) + w);
          exactConts.set(key, s);
        }
        const m = subUse.get(key) || new Map();
        m.set(cont, (m.get(cont) || 0) + w);
        subUse.set(key, m);
      }
    }
    return { usage, subUse, exactConts, vw };
  }
  
  function extractColors(samples) {
    // CSS 变量色：按“实际使用次数”排序，剔除仅声明未使用的非品牌色
    // （red-500 这类只用在单个角标上的调色板项不属于页面视觉语言）
    const varColors = extractCssVarColors();
    const { usage, subUse, exactConts } = countColorUsage(new Set(varColors.map(c => c.value.toLowerCase())));
    const isBrandLike = n => /brand|primary|accent|main|cta|link|logo|focus/i.test(n);
    // 页面自有 token 的常见命名空间；不在此列的（如 jjext-*）视为第三方自带命名
    const COMMON_NS = /^(color|bg|background|text|font|brand|primary|accent|theme|base|surface|border|fill|main|link|neutral|gray|grey|semantic|ui|tw|tailwind|design|token|sys|material|md|ant|el|van|arco|semi|app|site|page|global|common|default)/i;
    // 主导容器（权重最大）之外的精确使用权重 ≥ 0.1：
    // 插件变量只在自家 widget 内精确使用、或靠容差把页面近似色记到自己头上、
    // 或页面仅有零星同色元素时，都不算真实使用
    const exactOutsideDominant = key => {
      const exacts = exactConts.get(key);
      if (!exacts || !exacts.size) return false;
      const m = subUse.get(key);
      if (!m || !m.size) return false;
      let top = null, topW = 0;
      for (const [cont, w] of m) {
        if (w > topW) { topW = w; top = cont; }
      }
      let outside = 0;
      for (const [cont, w] of exacts) {
        if (cont !== top) outside += w;
      }
      return outside >= 0.1;
    };
    const colors = varColors
      .map(c => ({ ...c, count: usage.get(c.value.toLowerCase()) || 0, foreign: !COMMON_NS.test(c.name) }))
      .filter(c => {
        // 面积加权和 ≥ 0.5 才视为“页面核心色”；品牌名变量豁免但必须有真实使用
        const base = c.count >= 0.5 || (isBrandLike(c.name) && c.count > 0);
        if (!base) return false;
        // 第三方命名空间：必须在主导容器之外存在精确使用，否则剔除（两条陷阱）：
        // ① 使用量全靠容差误配（页面近似色被记到插件变量头上，如 #1a1a1a→#181818）；
        // ② 只在自家 widget 容器内精确使用（插件主题色）。
        // 页面自有命名空间不受此规则影响
        if (!COMMON_NS.test(c.name) && !exactOutsideDominant(c.value.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => b.count - a.count);
  
    const seen = new Set(colors.map(c => c.value.toLowerCase()));
    for (const item of extractFrequentColors(samples)) {
      if (colors.length >= 10) break;
      const key = item.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      colors.push({
        name: item.kind === 'bg' ? 'Background ' + item.value : 'Text ' + item.value,
        value: item.value,
        css: (item.kind === 'bg' ? 'background-color: ' : 'color: ') + item.value + ';',
        count: item.count
      });
    }
    return colors.slice(0, 10).map(({ name, value, css, kind, foreign }) => ({
      // 外部命名空间变量幸存时（色值确为页面所用），以中性名展示，不暴露插件变量名
      name: foreign ? (kind === 'bg' ? 'Background ' : 'Text ') + value : name,
      value,
      css
    }));
  }

  // 3) 语义角色色：交互元素显式采样 + :hover 规则解析 + 边框聚合
  // 扁平色板回答“页面有哪些颜色”，语义层回答“哪个色是按钮、哪个是链接、hover 变什么”
  function extractSemanticColors(samples) {
    const rootCs = getComputedStyle(document.documentElement);
    const resolveColor = v => {
      if (!v) return null;
      const m = /var\(\s*(--[\w-]+)/.exec(v);
      if (m) v = rootCs.getPropertyValue(m[1]).trim();
      return isColor(v) ? toHex(v) : null;
    };
    // :hover 规则（跳过扩展样式表，限量防失控）；文档顺序遍历，后匹配者覆盖 = 级联语义
    const hoverRules = [];
    for (const sheet of document.styleSheets) {
      if (/^(chrome|moz)-extension:/.test(sheet.href || '')) continue;
      const rs = safeRules(sheet);
      if (!rs) continue;
      walkRules(rs, rule => {
        // UA 默认规则（如 button:hover 的 buttonface）无样式表归属，会污染 hover 匹配
        if (rule.parentStyleSheet === null) return;
        if (!rule.style || !rule.selectorText || !/:hover/.test(rule.selectorText)) return;
        const decls = {};
        for (const p of ['color', 'background-color', 'border-color']) {
          const v = rule.style.getPropertyValue(p);
          if (v) decls[p] = v.trim();
        }
        if (!Object.keys(decls).length) return;
        for (const part of rule.selectorText.split(',')) {
          if (!/:hover/.test(part)) continue;
          const base = part.replace(/:hover/g, '').trim();
          if (base && base !== '*') hoverRules.push({ base, decls });
        }
      });
      if (hoverRules.length > 200) break;
    }
    const hoverVal = (el, prop) => {
      let val = null;
      for (const r of hoverRules) {
        if (!r.decls[prop]) continue;
        try { if (el.matches(r.base)) val = r.decls[prop]; } catch { /* 无效选择器 */ }
      }
      return resolveColor(val);
    };
    // 语义采样不限视口（CTA 常在首屏外），只要渲染可见
    const rendered = el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return r.width >= 4 && r.height >= 4 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const grab = (sel, limit) => {
      const arr = [];
      for (const el of document.querySelectorAll(sel)) {
        if (arr.length >= limit) break;
        if (rendered(el)) arr.push(el);
      }
      return arr;
    };
    // 近白中性色不算主色（白底描边按钮等），深色按钮保留
    const neutralLight = hex => {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return Math.max(r, g, b) - Math.min(r, g, b) <= 12 && (r + g + b) / 3 >= 240;
    };
    const topBy = (els, prop, skip) => {
      const freq = new Map();
      for (const el of els) {
        const hex = toHex(getComputedStyle(el)[prop]);
        if (!hex || skip(hex)) continue;
        const e = freq.get(hex) || { count: 0 };
        e.count++;
        freq.set(hex, e);
      }
      let top = null;
      for (const [value, e] of freq) if (!top || e.count > top.count) top = { value, count: e.count };
      return top;
    };
    // 同主色元素里最常见的 hover 值；computed 驼峰属性名 → CSSOM 短名键
    const hoverOf = (els, prop, baseValue) => {
      const kebab = prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
      const freq = new Map();
      for (const el of els) {
        if (toHex(getComputedStyle(el)[prop]) !== baseValue) continue;
        const hv = hoverVal(el, kebab);
        if (hv && hv !== baseValue) freq.set(hv, (freq.get(hv) || 0) + 1);
      }
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      return top && top[0];
    };

    const out = { primary: [], interactive: [], borders: [] };
    const buttons = grab('button, [role="button"], input[type="submit"], input[type="button"]', 30);
    const links = grab('a', 40);
    const inputs = grab('input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select', 20);

    const btnBg = topBy(buttons, 'backgroundColor', neutralLight);
    if (btnBg) {
      out.primary.push({
        role: '按钮主色', value: btnBg.value,
        hover: hoverOf(buttons, 'backgroundColor', btnBg.value),
        css: `background-color: ${btnBg.value};`
      });
    }
    const link = topBy(links, 'color', () => false);
    if (link) {
      out.interactive.push({
        role: '链接', value: link.value,
        hover: hoverOf(links, 'color', link.value),
        css: `color: ${link.value};`
      });
    }
    // 纯黑/纯白边框多为表格分隔线等结构性产物，不算设计 token
    const pureBlackWhite = hex => /^#(000000|FFFFFF)$/.test(hex);
    const borderEls = samples.filter(el => {
      const cs = getComputedStyle(el);
      return parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    });
    const border = topBy(borderEls, 'borderTopColor', pureBlackWhite);
    if (border) out.borders.push({ role: '边框', value: border.value, css: `border-color: ${border.value};` });
    const inputBorder = topBy(inputs, 'borderTopColor', pureBlackWhite);
    if (inputBorder && (!border || inputBorder.value !== border.value)) {
      out.borders.push({ role: '输入框边框', value: inputBorder.value, css: `border-color: ${inputBorder.value};` });
    }
    return out;
  }

  /* ================= 字体（语义标签采样） ================= */

  const TYPO_LEVELS = [
    ['H1', 'h1'], ['H2', 'h2'], ['H3', 'h3'], ['H4', 'h4'],
    ['正文', 'p'], ['链接', 'a'], ['按钮', 'button']
  ];

  function extractTypography(samples) {
    const out = [];
    // 标题不要求视口内（可能在首屏外），只要求渲染可见
    const rendered = el => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.fontSize) > 0;
    };
    const push = (level, el) => {
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const lh = cs.lineHeight === 'normal' ? 1.5 : Math.round((parseFloat(cs.lineHeight) / size) * 10) / 10;
      out.push({
        level,
        family: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
        size: cs.fontSize,
        weight: cs.fontWeight,
        css: `font: ${cs.fontWeight} ${cs.fontSize}/${lh} ${cs.fontFamily};`
      });
    };
    for (const [level, sel] of TYPO_LEVELS) {
      if (level === '正文') {
        // 正文取可见 p 中出现最多的字号，避免取到注释/角标等小字
        const stats = new Map();
        for (const p of document.querySelectorAll('p')) {
          if (!isVisible(p)) continue;
          const cs = getComputedStyle(p);
          const k = `${cs.fontSize}|${cs.fontWeight}|${cs.fontFamily}`;
          const e = stats.get(k) || { count: 0, el: p };
          e.count++;
          stats.set(k, e);
        }
        const top = [...stats.values()].sort((a, b) => b.count - a.count)[0];
        if (top) push('正文', top.el);
        continue;
      }
      const isHead = /^H\d/.test(level);
      const el = [...document.querySelectorAll(sel)].find(e => (isHead ? rendered(e) : isVisible(e)));
      if (el) push(level, el);
    }

    // 无语义标签页面（纯 div/span 构建）：按字号频次推断层级
    if (samples && samples.length) {
      const stats = new Map();
      for (const el of samples) {
        if (!(el.textContent || '').trim()) continue;
        const cs = getComputedStyle(el);
        const k = `${cs.fontSize}|${cs.fontWeight}|${cs.fontFamily}`;
        const e = stats.get(k) || { count: 0, el };
        e.count++;
        stats.set(k, e);
      }
      const entries = [...stats.values()];
      if (entries.length) {
        const bodyEntry = entries.slice().sort((a, b) => b.count - a.count)[0];
        if (!out.some(t => t.level === '正文')) push('正文', bodyEntry.el);
        if (!out.some(t => /^H\d/.test(t.level))) {
          const bodySize = parseFloat(getComputedStyle(bodyEntry.el).fontSize);
          const head = entries
            .filter(e => parseFloat(getComputedStyle(e.el).fontSize) > bodySize * 1.15)
            .sort((a, b) => parseFloat(getComputedStyle(b.el).fontSize) - parseFloat(getComputedStyle(a.el).fontSize))[0];
          if (head) push('H1', head.el);
        }
      }
    }

    const ORDER = ['H1', 'H2', 'H3', 'H4', '正文', '链接', '按钮'];
    out.sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
    return out;
  }

  /* ================= 间距（频次统计 + GCD 推算基础单元） ================= */

  function extractSpacing(samples) {
    const freq = new Map();
    const push = v => {
      const n = Math.round(parseFloat(v));
      if (!n || n <= 0 || n > 200) return;
      freq.set(n, (freq.get(n) || 0) + 1);
    };
    for (const el of samples) {
      const cs = getComputedStyle(el);
      [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft,
       cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft, cs.gap]
        .forEach(v => String(v).split(/\s+/).forEach(push));
    }
    const entries = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    // 基础单元优先用高频值（count≥2）推算，避免偶发值拖小单元
    const stable = entries.filter(([, c]) => c >= 2);
    const top = (stable.length >= 3 ? stable : entries)
      .slice(0, 6)
      .map(e => e[0])
      .sort((a, b) => a - b);
    if (!top.length) return [];
    const unit = top.reduce((a, b) => gcd(a, b)) || top[0];
    const rows = [{ name: '基础单元', value: unit + 'px', css: `gap: ${unit}px;` }];
    for (const v of top) {
      if (v === unit) continue;
      rows.push({ name: '常用间距', value: v + 'px', css: `gap: ${v}px;` });
    }
    return rows;
  }

  /* ================= 圆角 ================= */

  function radiusName(value, el) {
    if (value >= 999) return '胶囊';
    const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + el.tagName;
    if (/btn|button/i.test(cls)) return '按钮';
    if (/card|panel|modal|dialog/i.test(cls)) return '卡片';
    if (/input|field|select/i.test(cls)) return '输入框';
    return `圆角 ${value}px`;
  }

  function extractRadius(samples) {
    const freq = new Map();
    for (const el of samples) {
      let n = Math.round(parseFloat(getComputedStyle(el).borderRadius));
      if (!n) continue;
      if (n > 999) n = 9999; // 浏览器对超大圆角的钳位值（如 16777200px）统一为胶囊 9999px
      const e = freq.get(n) || { count: 0, el };
      e.count++;
      freq.set(n, e);
    }
    const used = new Set();
    return [...freq.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3)
      .map(([value, e]) => {
        let name = radiusName(value, e.el);
        if (used.has(name)) name = `圆角 ${value}px`;
        used.add(name);
        return { name, value: value + 'px', css: `border-radius: ${value}px;` };
      });
  }

  /* ================= 阴影 ================= */

  // 按括号深度拆分阴影层（rgba 内含逗号）
  function splitShadowLayers(v) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // 剥离全透明占位层（Tailwind shadow 变量常见噪声）
  function cleanShadow(v) {
    return splitShadowLayers(v)
      .filter(layer => !/rgba?\([^)]*,\s*0\s*\)/.test(layer))
      .join(', ');
  }

  function extractShadows(samples) {
    const freq = new Map();
    for (const el of samples) {
      const raw = getComputedStyle(el).boxShadow;
      if (!raw || raw === 'none') continue;
      const v = cleanShadow(raw);
      if (!v) continue;
      freq.set(v, (freq.get(v) || 0) + 1);
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([value], i) => ({
        name: i === 0 ? '默认' : `阴影 ${i + 1}`,
        value,
        css: `box-shadow: ${value};`
      }));
  }

  /* ================= 布局 ================= */

  function extractBreakpoints() {
    const set = new Set();
    for (const sheet of document.styleSheets) {
      const rules = safeRules(sheet);
      if (!rules) continue;
      walkRules(rules, rule => {
        const cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';
        const matches = String(cond).match(/(?:min|max)-width:\s*(\d+)px/g) || [];
        for (const m of matches) set.add(parseInt(m.match(/(\d+)px/)[1], 10));
      });
    }
    return [...set].sort((a, b) => a - b).slice(0, 6).map(v => v + 'px');
  }

  function extractLayout(samples) {
    let grid = 0, flex = 0;
    const widths = new Map();
    for (const el of samples) {
      const cs = getComputedStyle(el);
      if (el.children.length >= 2) {
        if (cs.display === 'grid') grid++;
        else if (cs.display.includes('flex')) flex++;
      }
      const mw = parseFloat(cs.maxWidth);
      if (mw >= 600 && mw <= 2000) widths.set(mw, (widths.get(mw) || 0) + 1);
    }
    const topWidth = [...widths.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      maxWidth: topWidth ? topWidth[0] + 'px' : null,
      mode: grid > 0 && grid >= flex ? 'grid' : (flex > 0 ? 'flex' : 'block'),
      breakpoints: extractBreakpoints()
    };
  }

  /* ================= 页面主背景色（Mood Board 自适应） ================= */

  function extractDominantBg() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (!isTransparent(bg)) return toHex(bg);
    }
    return '#FFFFFF';
  }

  /* ================= 汇总 ================= */

  function extract() {
    const samples = collectSamples();
    return {
      url: location.href,
      title: document.title,
      dominantBgColor: extractDominantBg(),
      tokens: {
        colors: extractColors(samples),
        semantic: extractSemanticColors(samples),
        typography: extractTypography(samples),
        spacing: extractSpacing(samples),
        radius: extractRadius(samples),
        shadows: extractShadows(samples)
      },
      layout: extractLayout(samples)
    };
  }
})();
