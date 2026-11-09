'use strict';

/*
 * JS / TS 语言包的静态求值（src/inspect/controls.js 用）。
 *
 * 不执行代码，只从 AST 里还原「字符串组成的嵌套对象」：
 *   export default { ... } / module.exports = { ... } / export default zh（顶层 const）
 *   export const zh = { ... }（没有默认导出时取唯一的命名导出；多个时合成 { 名称: 值 }）
 *   { ...common, save: '保存' }、`模板字符串（无插值）`、as const / satisfies / 类型断言
 *   defineMessages({ ... }) / defineLocale('zh', { ... }) 之类的包装调用：取第一个能求值的对象参数
 *   import common from './common' / import * as ns / import { a } / import zh from './zh.json'：
 *     按依赖图同一套规则（相对路径、目录 index、tsconfig 别名）解析项目内文件，递归求值
 * 求不出的值（函数、变量拼接、第三方包）跳过该键，其他键照常保留；用到这些键的控件会进 dynamic。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { resolveModuleSpecifier, SOURCE_EXTENSIONS } = require('../import-graph');

const MAX_DEPTH = 8;
const EXTENSIONS = [...SOURCE_EXTENSIONS.filter((e) => e !== '.mdx'), '.json', '.yaml', '.yml'];

let babelParser = null;
function parser() {
  if (!babelParser) babelParser = require('@babel/parser');
  return babelParser;
}

const SKIP = Symbol('skip');

function parse(file, source) {
  const ext = path.extname(file).toLowerCase();
  const plugins = ['.ts', '.mts', '.cts'].includes(ext) ? ['typescript'] : ext === '.tsx' ? ['typescript', 'jsx'] : ['jsx'];
  return parser().parse(source, {
    sourceType: 'unambiguous', errorRecovery: true, allowImportExportEverywhere: true, allowReturnOutsideFunction: true,
    plugins: [...plugins, 'decorators-legacy', 'importAttributes', 'topLevelAwait'],
  });
}

function keyOf(prop) {
  if (!prop.computed) {
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'StringLiteral') return prop.key.value;
    if (prop.key.type === 'NumericLiteral') return String(prop.key.value);
    return null;
  }
  if (prop.key.type === 'StringLiteral') return prop.key.value;
  if (prop.key.type === 'TemplateLiteral' && prop.key.expressions.length === 0) return prop.key.quasis[0].value.cooked;
  return null;
}

/**
 * 一个模块的求值上下文：顶层绑定（const / import）按需求值并缓存。
 * ctx = { projectRoot, modules: Map<abs, exports>, stack: Set<abs> }
 */
function createModule(abs, ast, ctx, depth) {
  const declarations = new Map(); // 名称 → AST 节点（const 初始化表达式）
  const imports = new Map(); // 名称 → { source, imported }
  const values = new Map();
  let defaultExport = null;
  const namedExports = new Map(); // 导出名 → 本地名或 AST 节点
  let commonjs = null;

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const spec of statement.specifiers) {
        const imported = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : (spec.imported.name ?? spec.imported.value);
        imports.set(spec.local.name, { source: statement.source.value, imported });
      }
      continue;
    }
    if (statement.type === 'ExportDefaultDeclaration') { defaultExport = statement.declaration; continue; }
    if (statement.type === 'ExportNamedDeclaration') {
      const decl = statement.declaration;
      if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.init) { declarations.set(d.id.name, d.init); namedExports.set(d.id.name, d.id.name); }
      }
      for (const spec of statement.specifiers || []) {
        const local = spec.local?.name;
        const exported = spec.exported?.name ?? spec.exported?.value;
        if (!local || !exported) continue;
        if (statement.source) {
          // export { default as zh } from './zh'
          imports.set(`__reexport_${exported}`, { source: statement.source.value, imported: local });
          namedExports.set(exported, `__reexport_${exported}`);
        } else if (exported === 'default') defaultExport = { type: 'Identifier', name: local };
        else namedExports.set(exported, local);
      }
      continue;
    }
    if (statement.type === 'VariableDeclaration') {
      for (const d of statement.declarations) if (d.id.type === 'Identifier' && d.init) declarations.set(d.id.name, d.init);
      continue;
    }
    if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression') {
      const { left, right } = statement.expression;
      const target = left.type === 'MemberExpression' ? `${left.object.name}.${left.property.name ?? left.property.value}` : null;
      if (target === 'module.exports') commonjs = right;
      else if (left.type === 'MemberExpression' && left.object.type === 'MemberExpression'
        && left.object.object.name === 'module' && left.object.property.name === 'exports') {
        // module.exports.x = ...
        namedExports.set(left.property.name, right);
      } else if (left.type === 'MemberExpression' && left.object.name === 'exports') namedExports.set(left.property.name, right);
    }
  }

  const lookup = (name) => {
    if (values.has(name)) return values.get(name);
    values.set(name, SKIP); // 自引用时止步
    let value = SKIP;
    if (declarations.has(name)) value = evaluate(declarations.get(name));
    else if (imports.has(name)) {
      const { source, imported } = imports.get(name);
      const target = resolveModuleSpecifier(ctx.projectRoot, abs, source, { extensions: EXTENSIONS });
      const exported = target ? loadModule(target, ctx, depth + 1) : null;
      if (exported) value = imported === '*' ? exported.all : imported === 'default' ? exported.default : (exported.named[imported] ?? SKIP);
    }
    values.set(name, value);
    return value;
  };

  function evaluate(node) {
    if (!node) return SKIP;
    switch (node.type) {
      case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'TSTypeAssertion': case 'ParenthesizedExpression':
        return evaluate(node.expression);
      case 'StringLiteral': return node.value;
      case 'TemplateLiteral': return node.expressions.length === 0 ? node.quasis.map((q) => q.value.cooked).join('') : SKIP;
      case 'Identifier': return lookup(node.name);
      case 'ObjectExpression': {
        const out = {};
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            const spread = evaluate(prop.argument);
            if (spread && typeof spread === 'object') Object.assign(out, spread);
            continue;
          }
          if (prop.type !== 'ObjectProperty') continue;
          const key = keyOf(prop);
          if (key === null) continue;
          const value = evaluate(prop.value);
          if (value !== SKIP && (typeof value === 'string' || (value && typeof value === 'object'))) out[key] = value;
        }
        return out;
      }
      case 'MemberExpression': {
        const object = evaluate(node.object);
        if (!object || typeof object !== 'object') return SKIP;
        const key = node.computed ? (node.property.type === 'StringLiteral' ? node.property.value : null) : node.property.name;
        return key !== null && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : SKIP;
      }
      case 'CallExpression': {
        // defineMessages({...}) / defineLocale('zh', {...}) / Object.freeze({...})：取第一个能求出对象的参数
        for (const arg of node.arguments) {
          const value = evaluate(arg);
          if (value && typeof value === 'object') return value;
        }
        return SKIP;
      }
      default: return SKIP;
    }
  }

  const named = {};
  for (const [exported, local] of namedExports) {
    const value = typeof local === 'string' ? lookup(local) : evaluate(local);
    if (value !== SKIP) named[exported] = value;
  }
  let def = defaultExport ? evaluate(defaultExport) : commonjs ? evaluate(commonjs) : SKIP;
  if (def === SKIP || !def || typeof def !== 'object') {
    const keys = Object.keys(named);
    def = keys.length === 1 && named[keys[0]] && typeof named[keys[0]] === 'object' ? named[keys[0]] : (keys.length ? named : null);
  }
  return { default: def, named, all: { ...named, ...(def && defaultExport ? { default: def } : {}) } };
}

function loadModule(abs, ctx, depth = 0) {
  if (ctx.modules.has(abs)) return ctx.modules.get(abs);
  if (depth > MAX_DEPTH || ctx.stack.has(abs)) return null;
  ctx.stack.add(abs);
  let result = null;
  try {
    const source = fs.readFileSync(abs, 'utf8');
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
      const data = ext === '.json' ? JSON.parse(source) : yaml.load(source);
      result = { default: data, named: data && typeof data === 'object' ? data : {}, all: data };
    } else {
      result = createModule(abs, parse(abs, source), ctx, depth);
    }
  } catch (_) {
    result = null;
  } finally {
    ctx.stack.delete(abs);
  }
  ctx.modules.set(abs, result);
  return result;
}

/**
 * 求出一个 JS / TS 语言包文件的默认导出对象；求不出时返回 null。
 * @param {string} projectRoot
 * @param {string} abs  文件绝对路径
 */
function evaluateMessagesModule(projectRoot, abs, ctx = { projectRoot, modules: new Map(), stack: new Set() }) {
  const exported = loadModule(abs, { ...ctx, projectRoot });
  const value = exported?.default;
  return value && typeof value === 'object' ? value : null;
}

module.exports = { evaluateMessagesModule };
