'use strict';

/*
 * 静态控件清单（src/inspect/controls.js）：从 JSX / Vue 模板提取控件角色与名称（字面量、aria-label、
 * 名称类 prop、语言包），名称不确定的列入 dynamic；describe 把 { control: id } 换成精确定位，
 * 引用不存在的控件拒绝写入，手写的 role + name 不在清单里给提示（strict 时拒绝）。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const controls = require('../src/inspect/controls');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function run(root, cmd, args = []) {
  return spawnSync(process.execPath, [CLI, cmd, '--project-root', root, ...args], { encoding: 'utf8' });
}

const PAGE_TSX = `import { Button, Tabs } from 'antd'
import { useTranslation } from 'react-i18next'
import Toolbar from '../../components/Toolbar'
export default function Page({ items }) {
  const { t } = useTranslation()
  return <div>
    <Toolbar />
    <Button type="primary">新建项目</Button>
    <button aria-label="关闭"><CloseIcon /></button>
    <Button icon={<Plus />} title="添加" />
    <button>{t('common.save')}</button>
    <button>{t('common.hello', { name })}</button>
    <button>{t('missing.key')}</button>
    {items.map((i) => <Button key={i.id}>删除 {i.name}</Button>)}
    <Tabs><Tabs.TabPane tab="基本信息" key="1"><p>内容</p></Tabs.TabPane></Tabs>
    <a href="/help">帮助中心</a>
    <input type="text" placeholder="搜索项目" />
    <button><FormattedMessage id="upload" /></button>
    <div onClick={go}>不是控件</div>
  </div>
}
`;
const TOOLBAR_TSX = `export default function Toolbar() {
  return <nav><Button>新建项目</Button><MyFancyAction>导出</MyFancyAction></nav>
}
`;
const LOCALE = { common: { save: '保存', hello: '你好 {name}' }, upload: '上传附件' };

function project() {
  const root = fx.makeTempDir('manual-controls-');
  fx.writePackageJson(root, { next: '^15.0.3', react: '^19.0.0' });
  fx.writeFile(root, 'app/projects/page.tsx', PAGE_TSX);
  fx.writeFile(root, 'components/Toolbar.tsx', TOOLBAR_TSX);
  fx.writeFile(root, 'locales/zh-CN.json', JSON.stringify(LOCALE));
  fx.writeFile(root, 'locales/en.json', JSON.stringify({ common: { save: 'Save' } }));
  const init = run(root, 'init', ['--base-url', 'http://localhost:3000']);
  assert.strictEqual(init.status, 0, init.stderr);
  return root;
}

function inspected(root) {
  const r = run(root, 'inspect', ['--json']);
  assert.strictEqual(r.status, 0, `inspect 失败: ${r.stderr}${r.stdout}`);
  const out = JSON.parse(r.stdout);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, '.manual/controls.json'), 'utf8'));
  const pageId = out.pages.find((p) => p.route === '/projects').id;
  return { out, snapshot, pageId, page: snapshot.pages[pageId] };
}

function describe(root, payload, args = []) {
  const file = path.join(root, 'describe.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return run(root, 'describe', ['--input', file, '--json', ...args]);
}

const byName = (page, role, name) => page.controls.find((c) => c.role === role && c.name === name);

process.stdout.write('controls.test.js\n');

test('JSX：字面量、aria-label、title、tab prop、placeholder 与语言包名称进入清单，依赖组件一起扫描', () => {
  const root = project();
  try {
    const { out, snapshot, page } = inspected(root);
    assert.strictEqual(snapshot.locale, 'zh-CN', '优先选 zh 语言包');
    assert.deepStrictEqual(snapshot.localeFiles, ['locales/zh-CN.json']);
    assert.ok(byName(page, 'button', '关闭'), 'aria-label');
    assert.strictEqual(byName(page, 'button', '添加').nameSource, 'title', '只有图标时用 title');
    assert.strictEqual(byName(page, 'button', '保存').i18nKey, 'common.save');
    assert.ok(byName(page, 'button', '上传附件'), '<FormattedMessage id>');
    assert.strictEqual(byName(page, 'tab', '基本信息').nameSource, 'tab', '标签页名称取 tab prop，不取面板内容');
    assert.ok(byName(page, 'link', '帮助中心'));
    assert.strictEqual(byName(page, 'textbox', '搜索项目').nameSource, 'placeholder');
    assert.ok(!page.controls.some((c) => c.name === '不是控件'), '普通 div 不算控件');
    assert.ok(!page.controls.some((c) => c.name === '导出'), '未登记的自定义组件不猜角色');
    const create = byName(page, 'button', '新建项目');
    assert.strictEqual(create.occurrences, 2, '页面与依赖组件里各一次');
    assert.ok(create.at.some((a) => a.startsWith('components/Toolbar.tsx:')));
    const reasons = page.dynamic.map((d) => d.reason).sort();
    assert.deepStrictEqual(reasons, ['dynamic-name', 'i18n-interpolated', 'i18n-key-unresolved']);
    assert.ok(page.dynamic.every((d) => /^app\/projects\/page\.tsx:\d+$/.test(d.at)), 'dynamic 附源码位置');
    assert.strictEqual(out.controls.pages[Object.keys(snapshot.pages)[0]].controls, page.controls.length);
  } finally { fx.cleanup(root); }
});

test('config：inspect.controls.components 登记自定义组件角色，locale 指定语言', () => {
  const root = project();
  try {
    const cfgFile = path.join(root, '.manual/config.yaml');
    const cfg = yaml.load(fs.readFileSync(cfgFile, 'utf8'));
    cfg.inspect = { ...(cfg.inspect || {}), controls: { components: { MyFancyAction: 'button' }, locale: 'en' } };
    fs.writeFileSync(cfgFile, yaml.dump(cfg));
    const { snapshot, page } = inspected(root);
    assert.strictEqual(snapshot.locale, 'en');
    assert.ok(byName(page, 'button', '导出'), '登记后识别为按钮');
    assert.ok(byName(page, 'button', 'Save'));
    cfg.inspect.controls = { components: { MyFancyAction: 'banana' } };
    fs.writeFileSync(cfgFile, yaml.dump(cfg));
    const bad = run(root, 'inspect', ['--json']);
    assert.notStrictEqual(bad.status, 0, '未知角色拒绝');
  } finally { fx.cleanup(root); }
});

test('describe：{ control } 换成精确 role + name；重复控件提示加 within', () => {
  const root = project();
  try {
    const { page, pageId } = inspected(root);
    const save = byName(page, 'button', '保存');
    const create = byName(page, 'button', '新建项目');
    const r = describe(root, { pages: [{ id: pageId, title: '项目列表', purpose: '查看和新建项目。', features: [
      { id: 'save', label: '保存', priority: 'required', target: { control: save.id } },
      { id: 'create', label: '新建项目', priority: 'required', target: { control: create.id } },
    ] }] });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.warnings.some((w) => w.includes('新建项目') && w.includes('within')), '重复控件提示');
    const yamlPage = yaml.load(fs.readFileSync(path.join(root, '.manual/pages', `${pageId}.yaml`), 'utf8'));
    assert.deepStrictEqual(yamlPage.features[0].target, { role: 'button', name: '保存', exact: true });
    assert.ok(!JSON.stringify(yamlPage).includes('"control"'), '页面定义里不留 control 引用');
  } finally { fx.cleanup(root); }
});

test('describe：引用不存在的控件拒绝写入；手写名称不在清单里给提示，strict 时拒绝', () => {
  const root = project();
  try {
    const { pageId } = inspected(root);
    const unknown = describe(root, { pages: [{ id: pageId, features: [{ id: 'x', label: 'x', priority: 'required', target: { control: 'ctl-000000000000' } }] }] });
    assert.notStrictEqual(unknown.status, 0);
    assert.ok(unknown.stdout.includes('ctl-000000000000'));
    const typo = { pages: [{ id: pageId, features: [{ id: 'save', label: '保存', priority: 'required', target: { role: 'button', name: 'common.save' } }] }] };
    const soft = describe(root, typo);
    assert.strictEqual(soft.status, 0, soft.stdout);
    assert.ok(JSON.parse(soft.stdout).warnings.some((w) => w.includes('common.save') && w.includes('不在静态控件清单里')));
    const cfgFile = path.join(root, '.manual/config.yaml');
    const cfg = yaml.load(fs.readFileSync(cfgFile, 'utf8'));
    cfg.inspect = { ...(cfg.inspect || {}), controls: { strict: true } };
    fs.writeFileSync(cfgFile, yaml.dump(cfg));
    const hard = describe(root, typo);
    assert.notStrictEqual(hard.status, 0, 'strict 拒绝清单外的手写定位');
    const ok = describe(root, { pages: [{ id: pageId, features: [{ id: 'save', label: '保存', priority: 'required', target: { role: 'button', name: '保存' } }] }] });
    assert.strictEqual(ok.status, 0, '与清单一致的手写定位照常通过');
  } finally { fx.cleanup(root); }
});

test('Vue 模板：$t / v-t / :aria-label / 组件库标签页 label；插槽图标不算名称', () => {
  const root = fx.makeTempDir('manual-controls-vue-');
  try {
    fx.writeFile(root, 'src/i18n/zh.json', JSON.stringify({ save: '保存', upload: '上传附件' }));
    fx.writeFile(root, 'src/V.vue', `<template>
  <div>
    <el-button type="primary">{{ $t('save') }}</el-button>
    <el-button :aria-label="$t('upload')"><el-icon /></el-button>
    <a-button><template #icon><PlusIcon /></template>新建</a-button>
    <router-link to="/a">首页</router-link>
    <el-tab-pane label="设置" name="s">内容</el-tab-pane>
    <el-button>{{ user.name }}</el-button>
    <button v-t="'upload'"></button>
  </div>
</template>
<script setup>
const x = 1
</script>
`);
    const locale = controls.loadLocale(root);
    const result = controls.extractControls(root, ['src/V.vue'], { messages: locale.messages });
    const names = result.controls.map((c) => `${c.role}:${c.name}`).sort();
    assert.deepStrictEqual(names, ['button:上传附件', 'button:保存', 'button:新建', 'link:首页', 'tab:设置']);
    assert.strictEqual(result.controls.find((c) => c.name === '上传附件').occurrences, 2);
    assert.deepStrictEqual(result.dynamic.map((d) => [d.reason, d.at]), [['dynamic-name', 'src/V.vue:8']]);
  } finally { fx.cleanup(root); }
});

test('TS / JS 语言包：静态求值 import（含 tsconfig 别名）、展开、satisfies / as const、包装调用；函数值跳过，不执行代码', () => {
  const root = fx.makeTempDir('manual-controls-ts-');
  try {
    fx.writeFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    fx.writeFile(root, 'src/lang/zh-CN.ts', `import common from './common.zh'
import { shared } from '@/shared/base'
import type { Messages } from './types'
const extra = { help: \`帮助中心\` }
globalThis.__executed = true
export default {
  common,
  ...shared,
  menu: { ...extra, 'log-out': '退出登录', count: (n: number) => \`\${n} 条\` },
  freeze: Object.freeze({ ok: '确定' }),
} satisfies Messages
`);
    fx.writeFile(root, 'src/lang/common.zh.ts', "export default { save: '保存' } as const\n");
    fx.writeFile(root, 'src/shared/base.ts', "export const shared = { upload: '上传附件' }\n");
    fx.writeFile(root, 'src/lang/zh-CN.d.ts', 'declare const x: any; export default x\n');
    fx.writeFile(root, 'src/lang/en.js', "module.exports = { common: { save: 'Save' } }\n");
    fx.writeFile(root, 'src/locales/zh-CN/orders.ts', "const orders = defineMessages({ refund: '申请退款' })\nexport default orders\n");

    const lang = controls.loadLocale(root, { dirs: ['src/lang'] });
    assert.strictEqual(lang.locale, 'zh-CN');
    assert.deepStrictEqual(lang.files, ['src/lang/zh-CN.ts'], '.d.ts 不算语言包');
    assert.deepStrictEqual(Object.fromEntries(lang.messages), {
      'common.save': '保存', upload: '上传附件', 'menu.help': '帮助中心', 'menu.log-out': '退出登录', 'freeze.ok': '确定',
    });
    assert.strictEqual(globalThis.__executed, undefined, '只读 AST，不执行语言包代码');
    assert.strictEqual(Object.fromEntries(controls.loadLocale(root, { dirs: ['src/lang'], locale: 'en' }).messages)['common.save'], 'Save', 'CommonJS');
    const ns = controls.loadLocale(root, { dirs: ['src/locales'] });
    assert.strictEqual(ns.messages.get('orders:refund'), '申请退款', '目录式命名空间');

    fx.writeFile(root, 'src/Page.tsx', "export default () => <div><button>{t('common.save')}</button><button>{t('menu.count')}</button></div>\n");
    const result = controls.extractControls(root, ['src/Page.tsx'], { messages: lang.messages });
    assert.deepStrictEqual(result.controls.map((c) => c.name), ['保存']);
    assert.deepStrictEqual(result.dynamic.map((d) => [d.reason, d.i18nKey]), [['i18n-key-unresolved', 'menu.count']], '求不出的值进 dynamic');
  } finally { fx.cleanup(root); }
});

test('resolveControlRefs：只改定位字段，alternatives 里的引用也解析', () => {
  const list = { controls: [{ id: 'ctl-a', role: 'button', name: '保存', occurrences: 1, at: ['x:1'] }], dynamic: [] };
  const { value, errors } = controls.resolveControlRefs({ note: { control: 'ctl-a' }, target: { control: 'ctl-zz', alternatives: [{ control: 'ctl-a' }] } }, list);
  assert.deepStrictEqual(value.note, { control: 'ctl-a' }, '非定位字段不动');
  assert.deepStrictEqual(value.target.alternatives[0], { role: 'button', name: '保存', exact: true });
  assert.strictEqual(errors.length, 1);
  const scoped = controls.resolveControlRefs({ targetHint: { control: 'ctl-a', within: { control: 'ctl-a' } } }, list);
  assert.deepStrictEqual(scoped.value.targetHint.within, { role: 'button', name: '保存', exact: true }, 'within 里的引用也解析');
  const conflict = controls.resolveControlRefs({ target: { control: 'ctl-a', name: '别的' } }, list);
  assert.ok(conflict.errors[0].includes('不能同时写'));
});

if (failures.length) { process.stdout.write(`\n${failures.length} 个失败，${passed} 个通过\n`); process.exit(1); }
process.stdout.write(`\n${passed} 个通过\n`);
