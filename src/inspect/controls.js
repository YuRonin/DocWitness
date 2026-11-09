'use strict';

/*
 * 静态控件清单：从页面入口与依赖源码里提取可交互控件的角色与无障碍名称。
 *
 * 目的：describe / layout 里的 target 不再由模型凭记忆手写 role + name，而是从这份清单里选
 * （`{ "control": "ctl-..." }`），由程序换成精确定位。模型写错控件名是标注失败最常见的原因
 * （照抄 i18n key、图标按钮没有文字、名称里有变量），静态清单把这类错误挡在建模阶段。
 *
 * 只提取能确定的名称：
 *   - 字面量文字、aria-label / title / placeholder 字面量
 *   - i18n 调用（t('k') / $t('k') / i18n.t('k') / intl.formatMessage({ id }) / <FormattedMessage id> / <Trans i18nKey>）
 *     按项目语言包（JSON / YAML / JS / TS）解析成实际文案
 * 名称含变量、条件表达式或解析不了的 key 的控件不猜，列入 dynamic（附源码位置），
 * 由模型读源码后自己写 target，并在浏览器里验证。
 *
 * 清单是线索而不是事实：最终仍以真实浏览器的唯一定位为准。同一角色 + 名称在页面源码里出现多次时
 * 记 occurrences > 1，提示需要用 within 限定区域。
 *
 * 只读源码，不执行代码；解析器延迟加载。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { sha256Hex } = require('../util/hash');
const { evaluateMessagesModule } = require('./lang/static-object');

let babelParser = null;
function parser() {
  if (!babelParser) babelParser = require('@babel/parser');
  return babelParser;
}
let vueCompiler = null;
function sfc() {
  if (!vueCompiler) vueCompiler = require('@vue/compiler-sfc');
  return vueCompiler;
}

const VERSION = 1;
const MAX_NAME = 80;

// 原生标签 → 角色（input 另按 type 判断）
const NATIVE_ROLES = { button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button' };
const INPUT_ROLES = {
  button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider',
  text: 'textbox', email: 'textbox', password: 'textbox', tel: 'textbox', url: 'textbox', search: 'searchbox', number: 'spinbutton', '': 'textbox',
};
const EXPLICIT_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'combobox', 'option', 'textbox', 'searchbox', 'slider', 'treeitem']);

// 常见组件库组件 → 角色。键统一成小写、去掉 - . _（Tabs.TabPane / el-tab-pane / ElTabPane 都是 tabstabpane / eltabpane）
const COMPONENT_ROLES = {
  button: 'button', iconbutton: 'button', loadingbutton: 'button', elbutton: 'button', abutton: 'button', vanbutton: 'button',
  nbutton: 'button', tbutton: 'button', vbtn: 'button', qbtn: 'button',
  link: 'link', navlink: 'link', routerlink: 'link', nuxtlink: 'link', ellink: 'link',
  tab: 'tab', tabpane: 'tab', tabstabpane: 'tab', tabstrigger: 'tab', eltabpane: 'tab', atabpane: 'tab', vantab: 'tab', ntabpane: 'tab', ttabpanel: 'tab',
  menuitem: 'menuitem', menuitemitem: 'menuitem', dropdownmenuitem: 'menuitem', dropdownitem: 'menuitem', elmenuitem: 'menuitem', amenuitem: 'menuitem',
  eldropdownitem: 'menuitem', nmenuitem: 'menuitem',
  checkbox: 'checkbox', elcheckbox: 'checkbox', acheckbox: 'checkbox', vancheckbox: 'checkbox', ncheckbox: 'checkbox',
  radio: 'radio', elradio: 'radio', aradio: 'radio', nradio: 'radio',
  switch: 'switch', elswitch: 'switch', aswitch: 'switch', vanswitch: 'switch', nswitch: 'switch',
  select: 'combobox', elselect: 'combobox', aselect: 'combobox', nselect: 'combobox',
  input: 'textbox', elinput: 'textbox', ainput: 'textbox', ninput: 'textbox', textarea: 'textbox',
};
// 名称来自 prop 而不是子节点的组件（Tab 的标题、表单控件的提示等）
const NAME_PROPS = ['aria-label', 'ariaLabel', 'label', 'tab', 'title', 'placeholder', 'value'];
const I18N_CALLEES = new Set(['t', '$t', 'tc', '$tc', 'i18n.t', 'i18n.global.t', 'this.$t', 'intl.formatMessage', 'formatMessage', 'translate']);

function toPosix(value) { return value.replace(/\\/g, '/'); }
function compact(text) { return String(text).replace(/\s+/g, ' ').trim(); }
function componentKey(tag) { return String(tag).toLowerCase().replace(/[-._:]/g, ''); }

/** 组件/标签 → 角色；只认原生控件、显式 role 与已知组件，自定义组件由 config 补充。 */
function roleFor(tag, attrs, extraComponents = {}) {
  const role = attrs.role?.kind === 'literal' ? attrs.role.value : null;
  if (role && EXPLICIT_ROLES.has(role)) return role;
  if (tag === 'a') return attrs.href || attrs[':href'] ? 'link' : null;
  if (tag === 'input') {
    const type = attrs.type?.kind === 'literal' ? String(attrs.type.value).toLowerCase() : '';
    return INPUT_ROLES[type] ?? null;
  }
  if (NATIVE_ROLES[tag]) return NATIVE_ROLES[tag];
  if (/^[a-z]/.test(tag) && !tag.includes('-')) return null; // 其他原生标签（div、span…）
  const key = componentKey(tag);
  if (extraComponents[key]) return extraComponents[key];
  if (COMPONENT_ROLES[key]) return COMPONENT_ROLES[key];
  if (/button$/.test(key) || /btn$/.test(key)) return 'button';
  return null;
}

// ---------------------------------------------------------------- 语言包

const LOCALE_DIRS = ['locales', 'src/locales', 'src/locale', 'src/i18n/locales', 'src/i18n/lang', 'src/i18n', 'src/lang', 'src/langs', 'public/locales', 'i18n', 'lang', 'messages', 'src/messages'];
const DATA_EXTS = new Set(['.json', '.yaml', '.yml']);
const SCRIPT_EXTS = new Set(['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts']);
const isLocaleFile = (name) => !/\.d\.[cm]?ts$/.test(name) && !/\.(test|spec)\.[cm]?[jt]s$/.test(name)
  && (DATA_EXTS.has(path.extname(name)) || SCRIPT_EXTS.has(path.extname(name)));

function flatten(value, prefix, out) {
  if (typeof value === 'string') { if (prefix && !out.has(prefix)) out.set(prefix, value); return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
}

function readMessages(projectRoot, file, evalCtx) {
  try {
    if (SCRIPT_EXTS.has(path.extname(file))) return evaluateMessagesModule(projectRoot, file, evalCtx);
    const text = fs.readFileSync(file, 'utf8');
    return path.extname(file) === '.json' ? JSON.parse(text) : yaml.load(text);
  } catch (_) { return null; }
}

/**
 * 找项目语言包并选定一种语言。支持 <dir>/<locale>.json|yaml|ts|js 与 i18next 的 <dir>/<locale>/<ns>.json|ts；
 * JS / TS 语言包静态求值（lang/static-object.js），不执行代码。
 * 语言优先级：config 指定 → zh 开头 → en 开头 → 字典序第一个。
 * @returns {{ locale, files: string[], messages: Map<string,string> }}
 */
function loadLocale(projectRoot, { locale = null, dirs = null } = {}) {
  const byLocale = new Map(); // locale → [{ file, ns }]
  for (const dir of dirs || LOCALE_DIRS) {
    const abs = path.join(projectRoot, dir);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (entry.isFile() && isLocaleFile(entry.name)) {
        const name = path.basename(entry.name, path.extname(entry.name));
        if (!/^[a-z]{2,3}([-_][A-Za-z]{2,4})*$/.test(name)) continue;
        if (!byLocale.has(name)) byLocale.set(name, []);
        byLocale.get(name).push({ file: path.join(abs, entry.name), ns: null });
      } else if (entry.isDirectory() && /^[a-z]{2,3}([-_][A-Za-z]{2,4})*$/.test(entry.name)) {
        for (const nsFile of fs.readdirSync(path.join(abs, entry.name))) {
          if (!isLocaleFile(nsFile)) continue;
          const ns = path.basename(nsFile, path.extname(nsFile));
          if (!byLocale.has(entry.name)) byLocale.set(entry.name, []);
          byLocale.get(entry.name).push({ file: path.join(abs, entry.name, nsFile), ns: ns === 'index' ? null : ns });
        }
      }
    }
  }
  const names = [...byLocale.keys()].sort();
  const chosen = (locale && byLocale.has(locale) ? locale : null)
    || names.find((n) => /^zh/i.test(n)) || names.find((n) => /^en/i.test(n)) || names[0] || null;
  const messages = new Map();
  const files = [];
  const evalCtx = { projectRoot, modules: new Map(), stack: new Set() };
  for (const { file, ns } of chosen ? byLocale.get(chosen) : []) {
    const data = readMessages(projectRoot, file, evalCtx);
    if (!data) continue;
    files.push(toPosix(path.relative(projectRoot, file)));
    const flat = new Map();
    flatten(data, '', flat);
    for (const [key, text] of flat) {
      if (ns) { messages.set(`${ns}:${key}`, text); messages.set(`${ns}.${key}`, text); }
      if (!messages.has(key)) messages.set(key, text);
    }
  }
  return { locale: chosen, files, messages, available: names };
}

// ---------------------------------------------------------------- 名称片段
// 片段：{ kind: 'literal', value } | { kind: 'i18n', key } | { kind: 'dynamic', hint }

function resolveParts(parts, messages) {
  let text = '';
  let source = 'text';
  const keys = [];
  for (const part of parts) {
    if (part.kind === 'literal') { text += part.value; continue; }
    if (part.kind === 'i18n') {
      keys.push(part.key);
      const value = messages.get(part.key);
      if (value === undefined) return { ok: false, reason: 'i18n-key-unresolved', i18nKey: part.key, partial: compact(text) };
      if (/\{\{?\s*[\w.]+\s*\}?\}|%\{?\w+\}?/.test(value)) return { ok: false, reason: 'i18n-interpolated', i18nKey: part.key, partial: compact(text + value) };
      text += value;
      source = 'i18n';
      continue;
    }
    return { ok: false, reason: 'dynamic-name', partial: compact(text), hint: part.hint };
  }
  const name = compact(text);
  if (!name) return { ok: false, reason: 'no-name' };
  if (name.length > MAX_NAME) return { ok: false, reason: 'name-too-long', partial: name.slice(0, 40) };
  return { ok: true, name, source, ...(keys.length ? { i18nKey: keys.join('+') } : {}) };
}

// ---------------------------------------------------------------- JSX

function calleeName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = calleeName(node.object);
    return object ? `${object}.${node.property.name}` : null;
  }
  return null;
}

function staticString(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** 表达式 → 名称片段。 */
function exprParts(node) {
  if (!node || node.type === 'JSXEmptyExpression') return [];
  const literal = staticString(node);
  if (literal !== null) return [{ kind: 'literal', value: literal }];
  if (node.type === 'CallExpression') {
    const callee = calleeName(node.callee);
    if (callee && (I18N_CALLEES.has(callee) || /(^|\.)\$?t$/.test(callee))) {
      const first = node.arguments[0];
      const key = staticString(first)
        ?? (first?.type === 'ObjectExpression' ? staticString(first.properties.find((p) => p.key?.name === 'id' || p.key?.value === 'id')?.value) : null);
      if (key) return [{ kind: 'i18n', key }];
    }
  }
  return [{ kind: 'dynamic', hint: node.type }];
}

function jsxTagName(name) {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return `${jsxTagName(name.object)}.${name.property.name}`;
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`;
  return '';
}

function jsxAttrs(opening) {
  const attrs = {};
  for (const attr of opening.attributes) {
    if (attr.type !== 'JSXAttribute') continue;
    const key = attr.name.type === 'JSXNamespacedName' ? `${attr.name.namespace.name}:${attr.name.name.name}` : attr.name.name;
    if (!attr.value) attrs[key] = { kind: 'literal', value: true };
    else if (attr.value.type === 'StringLiteral') attrs[key] = { kind: 'literal', value: attr.value.value };
    else if (attr.value.type === 'JSXExpressionContainer') {
      const parts = exprParts(attr.value.expression);
      attrs[key] = parts.length === 1 ? parts[0] : { kind: 'dynamic', hint: 'expression' };
    } else attrs[key] = { kind: 'dynamic', hint: attr.value.type };
  }
  return attrs;
}

/** 子节点文字：递归进入嵌套元素（图标 + 文字的按钮）；i18n 组件按 key 处理。 */
function jsxChildParts(children) {
  const parts = [];
  for (const child of children) {
    if (child.type === 'JSXText') parts.push({ kind: 'literal', value: child.value });
    else if (child.type === 'JSXExpressionContainer') parts.push(...exprParts(child.expression));
    else if (child.type === 'JSXFragment') parts.push(...jsxChildParts(child.children));
    else if (child.type === 'JSXElement') {
      const tag = jsxTagName(child.openingElement.name);
      const attrs = jsxAttrs(child.openingElement);
      if (tag === 'FormattedMessage' || tag === 'Trans') {
        const key = attrs.id || attrs.i18nKey;
        if (key?.kind === 'literal') parts.push({ kind: 'i18n', key: key.value });
        else if (tag === 'Trans' && child.children.length) parts.push(...jsxChildParts(child.children));
        else parts.push({ kind: 'dynamic', hint: tag });
      } else if (attrs['aria-hidden']?.value === true || attrs['aria-hidden']?.value === 'true') {
        continue;
      } else parts.push(...jsxChildParts(child.children));
    }
  }
  return parts;
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key.endsWith('Comments')) continue;
    const value = node[key];
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

function jsxElements(source, file) {
  const ext = path.extname(file).toLowerCase();
  const plugins = ['.ts', '.mts', '.cts'].includes(ext) ? ['typescript'] : ['.tsx'].includes(ext) ? ['typescript', 'jsx'] : ['jsx'];
  const ast = parser().parse(source, {
    sourceType: 'unambiguous', errorRecovery: true, allowImportExportEverywhere: true, allowReturnOutsideFunction: true,
    plugins: [...plugins, 'decorators-legacy', 'importAttributes', 'topLevelAwait'],
  });
  const found = [];
  walk(ast.program, (node) => {
    if (node.type !== 'JSXElement') return;
    const tag = jsxTagName(node.openingElement.name);
    found.push({ tag, attrs: jsxAttrs(node.openingElement), children: () => jsxChildParts(node.children), line: node.loc?.start.line || null });
  });
  return found;
}

// ---------------------------------------------------------------- Vue 模板

const VUE_ELEMENT = 1;
const VUE_TEXT = 2;
const VUE_INTERPOLATION = 5;
const VUE_ATTRIBUTE = 6;
const VUE_DIRECTIVE = 7;

/** Vue 绑定表达式（字符串）→ 名称片段：只认字符串字面量与 $t('key') / t('key')。 */
function vueExprParts(expression) {
  const exp = String(expression || '').trim();
  const literal = exp.match(/^(['"`])([^'"`$\\]*)\1$/);
  if (literal) return [{ kind: 'literal', value: literal[2] }];
  const call = exp.match(/^(?:\$t|t|\$tc|tc|i18n\.t|i18n\.global\.t)\(\s*(['"`])([^'"`]+)\1\s*(?:,[^)]*)?\)$/);
  if (call) return [{ kind: 'i18n', key: call[2] }];
  return [{ kind: 'dynamic', hint: 'binding' }];
}

function vueAttrs(node) {
  const attrs = {};
  for (const prop of node.props || []) {
    if (prop.type === VUE_ATTRIBUTE) attrs[prop.name] = { kind: 'literal', value: prop.value ? prop.value.content : true };
    else if (prop.type === VUE_DIRECTIVE && prop.name === 'bind' && prop.arg?.content) {
      const parts = vueExprParts(prop.exp?.content);
      attrs[prop.arg.content] = parts[0];
    } else if (prop.type === VUE_DIRECTIVE && prop.name === 'text') {
      attrs['v-text'] = vueExprParts(prop.exp?.content)[0];
    } else if (prop.type === VUE_DIRECTIVE && prop.name === 't') {
      // vue-i18n 的 v-t="'key'"
      const part = vueExprParts(prop.exp?.content)[0];
      attrs['v-text'] = part.kind === 'literal' ? { kind: 'i18n', key: part.value } : { kind: 'dynamic', hint: 'v-t' };
    }
  }
  return attrs;
}

function vueChildParts(children) {
  const parts = [];
  for (const child of children || []) {
    if (child.type === VUE_TEXT) parts.push({ kind: 'literal', value: child.content });
    else if (child.type === VUE_INTERPOLATION) parts.push(...vueExprParts(child.content?.content));
    else if (child.type === VUE_ELEMENT) {
      const attrs = vueAttrs(child);
      if (attrs['aria-hidden']?.value === 'true' || attrs['aria-hidden']?.value === true) continue;
      if (child.tag === 'i18n-t' || child.tag === 'i18n') {
        if (attrs.keypath?.kind === 'literal') parts.push({ kind: 'i18n', key: attrs.keypath.value });
        else parts.push({ kind: 'dynamic', hint: child.tag });
        continue;
      }
      if (attrs['v-text']) { parts.push(attrs['v-text']); continue; }
      // <template #icon> 之类的插槽内容不是名称
      if (child.tag === 'template' && (child.props || []).some((p) => p.type === VUE_DIRECTIVE && p.name === 'slot' && p.arg?.content && p.arg.content !== 'default')) continue;
      parts.push(...vueChildParts(child.children));
    }
  }
  return parts;
}

function vueElements(source, file) {
  const { descriptor } = sfc().parse(source, { filename: file, sourceMap: false, ignoreEmpty: true });
  const ast = descriptor.template?.ast;
  if (!ast) return [];
  const found = [];
  const visit = (node) => {
    if (node.type === VUE_ELEMENT) {
      const attrs = vueAttrs(node);
      found.push({ tag: node.tag, attrs, children: () => (attrs['v-text'] ? [attrs['v-text']] : vueChildParts(node.children)), line: node.loc?.start.line || null });
    }
    for (const child of node.children || []) visit(child);
  };
  visit(ast);
  return found;
}

// ---------------------------------------------------------------- 提取

/** 一个元素 → 控件或 dynamic 记录（不是控件返回 null）。 */
function controlOf(element, file, messages, extraComponents) {
  const role = roleFor(element.tag, element.attrs, extraComponents);
  if (!role) return null;
  const where = { file, line: element.line };
  if (element.attrs['aria-hidden']?.value === true || element.attrs['aria-hidden']?.value === 'true') return null;
  // 无障碍名称优先级：aria-label → 子节点文字 → 名称类 prop（label / tab / title / placeholder / value）
  const tries = [];
  const aria = element.attrs['aria-label'] || element.attrs.ariaLabel;
  if (aria) tries.push({ parts: [aria], from: 'aria-label' });
  const props = [];
  for (const prop of NAME_PROPS.slice(2)) {
    if (!element.attrs[prop]) continue;
    if (prop === 'value' && !(element.tag === 'input' && role === 'button')) continue;
    props.push({ parts: [element.attrs[prop]], from: prop });
  }
  // 标签页组件的子节点是面板内容，标题在 label / tab / title 上；输入类控件没有文字子节点
  const textual = !['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(role);
  const text = { parts: element.children(), from: 'text' };
  if (role === 'tab' && element.tag !== 'button' && props.length) tries.push(...props, ...(textual ? [text] : []));
  else tries.push(...(textual ? [text] : []), ...props);
  let firstFailure = null;
  for (const attempt of tries) {
    if (!attempt.parts.length) continue;
    const resolved = resolveParts(attempt.parts, messages);
    if (resolved.ok) {
      return { kind: 'control', role, name: resolved.name, nameSource: resolved.source === 'i18n' ? `i18n:${attempt.from}` : attempt.from, ...(resolved.i18nKey ? { i18nKey: resolved.i18nKey } : {}), where, component: element.tag };
    }
    // 子节点里只有图标（no-name）时继续尝试 title 等 prop；有变量的名称记第一处失败
    if (!firstFailure && resolved.reason !== 'no-name') firstFailure = { ...resolved, from: attempt.from };
  }
  const failure = firstFailure || { reason: 'no-name' };
  return {
    kind: 'dynamic', role, reason: failure.reason, where, component: element.tag,
    ...(failure.partial ? { partial: failure.partial } : {}), ...(failure.i18nKey ? { i18nKey: failure.i18nKey } : {}),
  };
}

function controlId(role, name) {
  return `ctl-${sha256Hex(JSON.stringify([role, name])).slice(0, 12)}`;
}

/**
 * 提取一组源码文件的控件。
 * @param {string} projectRoot
 * @param {string[]} files            相对项目根的路径
 * @param {object} options
 * @param {Map} options.messages      语言包（loadLocale().messages）
 * @param {object} [options.components]  自定义组件 → 角色（config.inspect.controls.components）
 * @param {Map} [options.cache]       跨页面复用的文件解析结果
 */
function extractControls(projectRoot, files, { messages = new Map(), components = {}, cache = new Map() } = {}) {
  const extra = Object.fromEntries(Object.entries(components).map(([k, v]) => [componentKey(k), v]));
  const byId = new Map();
  const dynamic = [];
  const errors = [];
  for (const file of files) {
    if (!/\.(jsx?|tsx|mjs|cjs|vue)$/.test(file)) continue;
    let elements = cache.get(file);
    if (!elements) {
      try {
        const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
        elements = file.endsWith('.vue') ? vueElements(source, file) : (/<[A-Za-z]/.test(source) ? jsxElements(source, file) : []);
      } catch (error) {
        errors.push({ file, message: String(error.message).split('\n')[0] });
        elements = [];
      }
      cache.set(file, elements);
    }
    for (const element of elements) {
      const found = controlOf(element, file, messages, extra);
      if (!found) continue;
      const at = found.where.line ? `${file}:${found.where.line}` : file;
      if (found.kind === 'dynamic') {
        dynamic.push({ role: found.role, reason: found.reason, at, component: found.component, ...(found.partial ? { partial: found.partial } : {}), ...(found.i18nKey ? { i18nKey: found.i18nKey } : {}) });
        continue;
      }
      const id = controlId(found.role, found.name);
      if (!byId.has(id)) {
        byId.set(id, { id, role: found.role, name: found.name, nameSource: found.nameSource, ...(found.i18nKey ? { i18nKey: found.i18nKey } : {}), occurrences: 0, at: [] });
      }
      const entry = byId.get(id);
      entry.occurrences += 1;
      if (entry.at.length < 5) entry.at.push(at);
    }
  }
  const controls = [...byId.values()].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  return { controls, dynamic, errors };
}

function controlsFileFor(stateDirAbs) {
  return path.join(stateDirAbs, 'controls.json');
}

/** 页面要扫的文件：入口 + 依赖（含框架约定文件）。 */
function pageFiles(page) {
  const deps = page.dependencies || {};
  return [...new Set([page.entry, ...(deps.scope || []), ...(deps.files || [])].filter(Boolean))];
}

/**
 * 为全部页面建立静态控件清单。
 * @returns {{ version, locale, localeFiles, pages: { [pageId]: { route, files, controls, dynamic, errors } } }}
 */
function buildControlsSnapshot(projectRoot, pages, options = {}) {
  const settings = options.settings || {};
  const locale = loadLocale(projectRoot, { locale: settings.locale || null, dirs: settings.localeDirs || null });
  const cache = new Map();
  const out = {};
  for (const page of pages) {
    if (!page?.id || !page.entry || page.lifecycle === 'missing' || page.lifecycle === 'excluded') continue;
    const files = pageFiles(page);
    const result = extractControls(projectRoot, files, { messages: locale.messages, components: settings.components || {}, cache });
    out[page.id] = { route: page.route, files: files.length, ...result };
  }
  return { version: VERSION, locale: locale.locale, localeFiles: locale.files, pages: out };
}

function writeControls(stateDirAbs, snapshot) {
  const file = controlsFileFor(stateDirAbs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  return file;
}

function readControls(stateDirAbs) {
  try { return JSON.parse(fs.readFileSync(controlsFileFor(stateDirAbs), 'utf8')); } catch (_) { return null; }
}

// ---------------------------------------------------------------- 引用解析

const TARGET_CONTAINERS = new Set(['target', 'targetHint', 'within']);

/**
 * 把页面定义里的 `{ control: "ctl-..." }` 换成 `{ role, name, exact: true }`，并核对手写的 role + name。
 * 只看定位字段（target / targetHint / within / alternatives[]），不改其他内容。
 * @returns {{ value, errors: string[], warnings: string[] }}
 */
function resolveControlRefs(value, pageControls, { where = '', strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const list = pageControls?.controls || [];
  const byId = new Map(list.map((c) => [c.id, c]));

  const resolveTarget = (target, at) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
    let next = { ...target };
    if (next.within) next.within = resolveTarget(next.within, `${at}.within`);
    if (Array.isArray(next.alternatives)) next.alternatives = next.alternatives.map((t, i) => resolveTarget(t, `${at}.alternatives[${i}]`));
    if (next.control !== undefined) {
      if (!pageControls) { errors.push(`${at}.control: 没有静态控件清单，先运行 \`manual inspect\`。`); return next; }
      const control = byId.get(next.control);
      if (!control) { errors.push(`${at}.control: ${next.control} 不在本页面的静态控件清单里（.manual/controls.json）；清单变了就重新选择，或手写 role + name。`); return next; }
      const conflicting = ['role', 'name', 'label', 'text', 'testId', 'selector'].filter((k) => next[k] !== undefined);
      if (conflicting.length) { errors.push(`${at}: control 已经确定了定位，不能同时写 ${conflicting.join(' / ')}。`); return next; }
      const { control: _ignored, ...rest } = next;
      next = { role: control.role, name: control.name, exact: true, ...rest };
      if (control.occurrences > 1 && !next.within) warnings.push(`${at}: 「${control.name}」（${control.role}）在页面源码里出现 ${control.occurrences} 次（${control.at.join('，')}），浏览器里可能不唯一，建议加 within 限定区域。`);
      return next;
    }
    if (pageControls && next.role && next.name && !list.some((c) => c.role === next.role && c.name === next.name)) {
      const near = suggestions(list, next);
      const message = `${at}: 手写的 ${next.role}「${next.name}」不在静态控件清单里${near.length ? `；相近的有 ${near.map((c) => `${c.id} ${c.role}「${c.name}」`).join('，')}` : ''}。名称来自变量或运行时数据时可以忽略，但要在 plan-capture --live 里确认能定位。`;
      if (strict) errors.push(`${message}（inspect.controls.strict 已开启：改用 control 引用，或关闭 strict）`);
      else warnings.push(message);
    }
    return next;
  };

  const visit = (node, at) => {
    if (Array.isArray(node)) return node.map((item, i) => visit(item, `${at}[${i}]`));
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      if (TARGET_CONTAINERS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) out[key] = resolveTarget(child, at ? `${at}.${key}` : key);
      else out[key] = visit(child, at ? `${at}.${key}` : key);
    }
    return out;
  };

  return { value: visit(value, where), errors, warnings };
}

function suggestions(list, target) {
  const name = String(target.name);
  return list
    .filter((c) => c.name.includes(name) || name.includes(c.name) || (c.role === target.role && sharedChars(c.name, name) >= Math.min(2, name.length)))
    .sort((a, b) => Number(b.role === target.role) - Number(a.role === target.role))
    .slice(0, 3);
}

function sharedChars(a, b) {
  const set = new Set(a);
  return [...new Set(b)].filter((ch) => set.has(ch)).length;
}

module.exports = {
  VERSION, loadLocale, extractControls, buildControlsSnapshot, writeControls, readControls, controlsFileFor, resolveControlRefs, controlId, roleFor,
};
