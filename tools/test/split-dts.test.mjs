import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, cpSync, readFileSync as rf, writeFileSync as wf, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseDeclarations, parseBp, parseSource, ParseError, SOURCES } from '../lib/parse.mjs';
import { sortUnits, pack, assertUniqueNames, PackError } from '../lib/pack.mjs';
import { layoutFragment, cleanOrphans, ORPHAN_PREFIX, FRAGMENTS_DIR, assertPrefixesDisjoint } from '../lib/emit.mjs';
import { META_VERSION, buildMeta, buildRows, serialize, parseManifest, planRun, mergeRows, mergeMeta } from '../lib/manifest.mjs';
import {
  checkContentIntegrity, checkCompileIsolation, checkFragmentLength, checkManifestConsistency, checkPackageNotSplit,
  checkMarkerPairs, checkUnitsNonEmpty,
} from '../lib/verify.mjs';
import { findProjectRoot } from '../split-dts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (...p) => readFileSync(join(HERE, 'fixtures', ...p), 'utf8');

describe('parse: 4 空格声明族', () => {
  const text = fx('four-space', 'Typing', 'ue', 'ue.d.ts');

  test('按声明行切出单元，起止行含端点且 1-based', () => {
    const units = parseDeclarations(text);
    assert.deepEqual(units.map((u) => u.name), ['Plane', 'Actor', 'EMovementMode']);
    assert.deepEqual(units.map((u) => u.kind), ['class', 'class', 'enum']);
    // fixture 行号：1 ref / 2 declare / 3 import / 4 空 / 5 class Plane … 8 `}` / 9 空
    //               10 class Actor … 12 `}` / 13 enum … 16 `}` / 17 trailer `}`
    // Plane：起于 5，止于下一个匹配行(Actor)的前一行 = 9
    assert.equal(units[0].startLine, 5);
    assert.equal(units[0].endLine, 9);
    assert.equal(units[0].lines, 5);
    // Actor：起于 10，止于 12
    assert.equal(units[1].startLine, 10);
    assert.equal(units[1].endLine, 12);
    assert.equal(units[1].lines, 3);
    // EMovementMode：起于 13，止于 16（第 17 行是 trailer，不属于任何单元）
    assert.equal(units[2].startLine, 13);
    assert.equal(units[2].endLine, 16);
    assert.equal(units[2].lines, 4);
  });

  test('单元 text 逐字节等于源文件该行区间', () => {
    const units = parseDeclarations(text);
    const lines = text.split(/(?<=\n)/);
    for (const u of units) {
      assert.equal(u.text, lines.slice(u.startLine - 1, u.endLine).join(''));
    }
  });

  test('extends 抽取：仅 UE.<X> 形态', () => {
    const units = parseDeclarations(text);
    assert.equal(units[0].extends, 'UE.Vector');
    assert.equal(units[2].extends, null);
  });

  test('非 bp 源 pkg / root 恒为 null', () => {
    for (const u of parseDeclarations(text)) {
      assert.equal(u.pkg, null);
      assert.equal(u.root, null);
    }
  });

  test('trailer（declare module 的闭合括号）不属于任何单元', () => {
    const units = parseDeclarations(text);
    const last = units[units.length - 1];
    assert.doesNotMatch(last.text, /^\}\s*$/m);
    assert.notEqual(last.endLine, text.split(/(?<=\n)/).length);
  });

  test('kinds 筛选：只收 class', () => {
    const units = parseDeclarations(text, ['class']);
    assert.deepEqual(units.map((u) => u.name), ['Plane', 'Actor']);
  });

  test('筛掉全部声明时抛 ParseError（不得静默返回空数组）', () => {
    assert.throws(() => parseDeclarations(text, ['interface']), ParseError);
  });

  test('无声明抛 ParseError', () => {
    assert.throws(() => parseDeclarations('declare module "x" {\n}\n'), ParseError);
  });
});

describe('parse: 边界是"下一个匹配行"而非"下一个同类行"', () => {
  const text = fx('four-space', 'Typing', 'ue', 'puerts_decorators.d.ts');

  test('namespace ue 不被其后的 function / type / const 撑大', () => {
    const units = parseDeclarations(text);
    const ns = units.find((u) => u.name === 'ue');
    assert.equal(ns.kind, 'namespace');
    assert.equal(ns.lines, 4, 'namespace ue 应只含自身 4 行');
    assert.doesNotMatch(ns.text, /set_flags/);
  });

  test('abstract class 归一为 kind class', () => {
    const units = parseDeclarations(text);
    const c = units.find((u) => u.name === 'FFloat16Color');
    assert.equal(c.kind, 'class');
  });

  test('同名 type 与 const 各产一个单元（name 不唯一是事实）', () => {
    const units = parseDeclarations(text);
    const hits = units.filter((u) => u.name === 'BuiltinBool');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((u) => u.kind).sort(), ['const', 'type']);
  });

  test('本 fixture 的 6 个 4 空格声明全部被识别（namespace 内 8 空格的 const 不算）', () => {
    const units = parseDeclarations(text);
    assert.deepEqual(units.map((u) => u.name),
      ['ue', 'set_flags', 'clear_flags', 'BuiltinBool', 'BuiltinBool', 'FFloat16Color']);
    assert.deepEqual(units.map((u) => u.kind),
      ['namespace', 'function', 'function', 'type', 'const', 'class']);
  });
});

describe('parse: bp 标记对族', () => {
  const text = fx('markers', 'Typing', 'ue', 'ue_bp.d.ts');

  test('只有标记对之间的内容成为单元', () => {
    const { units, markerPairs } = parseBp(text);
    assert.equal(markerPairs, 3);
    assert.equal(units.length, 3, '未加标记的 namespace 块不得成为单元');
    assert.deepEqual(units.map((u) => u.name), ['BP_Boss_C', 'EPyKind', 'FPyObject']);
  });

  test('单元文本含起止标记本身', () => {
    const { units } = parseBp(text);
    assert.match(units[0].text, /^\/\/ __TYPE_DECL_START: /);
    // 本仓 core.autocrlf=true 且无 .gitattributes：新机器检出时 fixture 是 CRLF，
    // END 行内会带 \r（body() 解析时剥掉，但断言直接看单元原文）—— 故 \r? 必须容忍
    assert.match(units[0].text, /\/\/ __TYPE_DECL_END\r?\n?$/);
  });

  test('pkg 从单元内 4 空格 namespace 行抽取，root 为其首个点分段', () => {
    const { units } = parseBp(text);
    assert.equal(units[0].pkg, 'Game.TopDown.Blueprints');
    assert.equal(units[0].root, 'Game');
    assert.equal(units[1].pkg, 'Game.PythonTypes');
    assert.equal(units[1].root, 'Game');
    assert.equal(units[2].pkg, 'Engine.PythonTypes');
    assert.equal(units[2].root, 'Engine');
  });

  test('kind 取 8 空格处的声明关键字', () => {
    const { units } = parseBp(text);
    assert.deepEqual(units.map((u) => u.kind), ['class', 'enum', 'class']);
  });

  test('无点分段的 package：root 取整串', () => {
    const one = '// __TYPE_DECL_START: 5.7\n    namespace Solo {\n        class A {\n        }\n\n    }\n// __TYPE_DECL_END\n';
    const { units } = parseBp(one);
    assert.equal(units[0].pkg, 'Solo');
    assert.equal(units[0].root, 'Solo');
  });

  test('8 空格陷阱：把 4 空格 class/enum 规则套到 bp 上得 0 个单元', () => {
    assert.throws(() => parseDeclarations(text, ['class', 'enum']), ParseError,
      'bp 的 class/enum 在 8 空格 —— 4 空格规则必须一无所获（这正是必须用标记对的原因）');
  });

  test('4 空格处确实有 namespace 行 —— 所以"宽规则"能匹配到包裹行而非类型', () => {
    const wrappers = parseDeclarations(text, ['namespace']);
    assert.equal(wrappers.length, 4, '4 个 namespace 行（3 个在标记对内 + 1 个未加标记）');
    // 这些"单元"的名字是 package 首段，不是类型名 —— 宽规则在这里给出的是垃圾，不是数据
    assert.deepEqual(wrappers.map((u) => u.name), ['Game', 'Game', 'Game', 'Engine']);
  });

  test('标记不成对：缺 END 抛 ParseError', () => {
    const noEnd = '// __TYPE_DECL_START: 5.7\n    namespace A {\n        class B {\n        }\n\n    }\n';
    assert.throws(() => parseBp(noEnd), ParseError);
  });

  test('标记不成对：缺 START 抛 ParseError', () => {
    const noStart = '    namespace A {\n        class B {\n        }\n\n    }\n// __TYPE_DECL_END\n';
    assert.throws(() => parseBp(noStart), ParseError);
  });

  test('单元内无 namespace 行：抛 ParseError（对应 WITHOUT_BP_NAMESPACE 被定义的情况）', () => {
    const noNs = '// __TYPE_DECL_START: 5.7\n    class A {\n    }\n// __TYPE_DECL_END\n';
    assert.throws(() => parseBp(noNs), ParseError);
  });

  test('pkg 由 parseSource 分流得到，未切分源 pkg 恒为 null', () => {
    assert.equal(parseSource('bp', text).units[0].pkg, 'Game.TopDown.Blueprints');
    assert.equal(parseSource('ue', fx('four-space', 'Typing', 'ue', 'ue.d.ts')).units[0].pkg, null);
  });
});

// 造单元的小工具。text 必须**像真的声明**（首行含 `class <name>`），
// 否则 Task 4 的 "placements.line 指向正文中该声明" 断言无从验证。
const U = (name, lines, extra = {}) => {
  const body = Array.from({ length: lines }, (_, i) =>
    (i === 0 ? `    class ${name} {` : `        // ${i}`));
  if (lines > 1) body[lines - 1] = '    }';
  return {
    name, kind: 'class', pkg: null, root: null, extends: null,
    startLine: 1, endLine: lines, lines, text: body.join('\n') + '\n', ...extra,
  };
};

describe('pack: 贪心装箱与判据前置', () => {
  test('判据前置：装不下就先切，不得把分片顶过阈值', () => {
    // 阈值 10，两个 9 行单元：朴素"先加后判"会产出 18 行一片
    const frags = pack([U('A', 9), U('B', 9)], { threshold: 10, id: 'ue' });
    assert.equal(frags.length, 2);
    for (const f of frags) {
      const total = f.units.reduce((n, u) => n + u.lines, 0);
      assert.ok(total <= 10, `分片 ${f.name} 超阈值: ${total}`);
    }
  });

  test('能装下就合并', () => {
    const frags = pack([U('A', 3), U('B', 4)], { threshold: 10, id: 'ue' });
    assert.equal(frags.length, 1);
    assert.deepEqual(frags[0].units.map((u) => u.name), ['A', 'B']);
  });

  test('单单元超阈值走例外分支，片名为 ue-<Name>-NNN（与常规片共用一个序号计数器）', () => {
    // 排序后为 Big(25) / Small(2) / Tiny(2)。Big 超阈值 -> 例外片 001/002/003，
    // 随后的常规片（Small+Tiny=4 行）继续用 004。
    // 单一计数器是"同 id 内片名必然唯一"的最简保证，故这里断言**完整序列**而非包含关系。
    const frags = pack([U('Small', 2), U('Big', 25), U('Tiny', 2)], { threshold: 10, id: 'ue' });
    assert.deepEqual(frags.map((f) => f.name), [
      'ue-Big-001.d.txt', 'ue-Big-002.d.txt', 'ue-Big-003.d.txt', 'ue.004.d.txt',
    ]);
  });

  test('例外分片自身也不得超阈值', () => {
    const frags = pack([U('Big', 25)], { threshold: 10, id: 'ue' });
    for (const f of frags) {
      assert.ok(f.units.reduce((n, u) => n + u.lines, 0) <= 10);
    }
    assert.equal(frags.length, 3);
  });

  test('常规分片按序号命名，序号从 001 起且连续', () => {
    const frags = pack([U('A', 9), U('B', 9), U('C', 9)], { threshold: 10, id: 'ue' });
    assert.deepEqual(frags.map((f) => f.name), ['ue.001.d.txt', 'ue.002.d.txt', 'ue.003.d.txt']);
  });

  test('decorators 用 decorators. 前缀', () => {
    const frags = pack([U('A', 9), U('B', 9)], { threshold: 10, id: 'decorators' });
    assert.deepEqual(frags.map((f) => f.name), ['decorators.001.d.txt', 'decorators.002.d.txt']);
  });
});

describe('pack: 排序键', () => {
  test('单级键（name）：按声明名稳定排序', () => {
    const out = sortUnits([U('C', 1), U('A', 1), U('B', 1)], 'name');
    assert.deepEqual(out.map((u) => u.name), ['A', 'B', 'C']);
  });

  test('稳定性：等键单元保持输入顺序（分片可复现的唯一来源）', () => {
    const a = U('Same', 1, { startLine: 10 });
    const b = U('Same', 1, { startLine: 20 });
    const out = sortUnits([a, b], 'name');
    assert.deepEqual(out.map((u) => u.startLine), [10, 20]);
  });

  test('三级键（bp）：packageRoot → package 全路径 → 类型名', () => {
    const mk = (name, pkg) => U(name, 1, { pkg, root: pkg.split('.')[0] });
    const input = [
      mk('Z', 'Niagara.Foo'),
      mk('B', 'Engine.PythonTypes'),
      mk('A', 'Engine.PythonTypes'),
      mk('Y', 'Engine.Aaa'),
      mk('X', 'Game.Zzz'),
    ];
    const out = sortUnits(input, 'bp');
    assert.deepEqual(out.map((u) => `${u.pkg}/${u.name}`), [
      'Engine.Aaa/Y',
      'Engine.PythonTypes/A',
      'Engine.PythonTypes/B',
      'Game.Zzz/X',
      'Niagara.Foo/Z',
    ]);
  });

  test('bp 三级键使同一 package 的单元必然相邻（package 不跨片的充分条件）', () => {
    const mk = (name, pkg) => U(name, 1, { pkg, root: pkg.split('.')[0] });
    const out = sortUnits([
      mk('A1', 'Game.A'), mk('B1', 'Game.B'), mk('A2', 'Game.A'), mk('B2', 'Game.B'),
    ], 'bp');
    const pkgs = out.map((u) => u.pkg);
    const seen = new Set();
    let prev = null;
    for (const p of pkgs) {
      if (p !== prev) { assert.ok(!seen.has(p), `package ${p} 不连续`); seen.add(p); prev = p; }
    }
  });
});

describe('pack: packageRoot 硬边界与文件名唯一性', () => {
  test('分片不跨 packageRoot', () => {
    const mk = (name, pkg) => U(name, 6, { pkg, root: pkg.split('.')[0] });
    const frags = pack([mk('A', 'Engine.X'), mk('B', 'Niagara.Y'), mk('C', 'Engine.X')],
      { threshold: 10, id: 'bp' });
    for (const f of frags) {
      assert.equal(new Set(f.units.map((u) => u.root)).size, 1, `${f.name} 跨了 root`);
    }
  });

  test('同组内两个 root：必须逐 root 拆片，且序号跨 root 共享', () => {
    const mk = (name, pkg) => U(name, 6, { pkg, root: pkg.split('.')[0] });
    // 排序后为 Engine.X/A、Engine.X/C、Niagara.Y/B，合计 18 <= 21 => 三者同处**一个**常规组。
    // 这条测试是"逐 root 拆片"分支的唯一覆盖点（其余测试每片只含一个 root，该分支不会被走到）：
    //  - 不拆 => 只剩 1 片，名字撒谎（bp-Engine 里装 Niagara 类型）
    //  - 序号按 root 各自计数 => Niagara 会拿到 -001
    const frags = pack([mk('A', 'Engine.X'), mk('B', 'Niagara.Y'), mk('C', 'Engine.X')],
      { threshold: 21, id: 'bp' });
    assert.deepEqual(frags.map((f) => f.name), ['bp-Engine-001.d.txt', 'bp-Niagara-002.d.txt']);
    assert.deepEqual(frags.map((f) => f.units.map((u) => u.name)), [['A', 'C'], ['B']]);
  });

  test('package 不跨片（硬约束，实测源文件 0 个被拆散）', () => {
    const mk = (name, pkg) => U(name, 3, { pkg, root: pkg.split('.')[0] });
    const frags = pack([
      mk('A', 'Game.P1'), mk('B', 'Game.P1'), mk('C', 'Game.P2'), mk('D', 'Game.P1'),
    ], { threshold: 10, id: 'bp' });
    const where = new Map();
    for (const f of frags) {
      for (const u of f.units) {
        if (!where.has(u.pkg)) where.set(u.pkg, new Set());
        where.get(u.pkg).add(f.name);
      }
    }
    for (const [pkg, set] of where) {
      assert.equal(set.size, 1, `package ${pkg} 跨了 ${set.size} 个分片`);
    }
  });

  test('例外分片名用 package 全路径（点换连字符）', () => {
    const mk = (name, pkg) => U(name, 25, { pkg, root: pkg.split('.')[0] });
    const frags = pack([mk('A', 'Engine.PythonTypes')], { threshold: 10, id: 'bp' });
    assert.ok(frags.every((f) => f.name.startsWith('bp-Engine-PythonTypes-')),
      `实际: ${frags.map((f) => f.name)}`);
  });

  test('文件名冲突必须响亮失败，不得自动改名', () => {
    // root='A-B' 的常规片 bp-A-B-001 vs root='A' + package='B' 的例外片 bp-A-B-001
    const frags = [
      { name: 'bp-A-B-001.d.txt', units: [U('x', 1)] },
      { name: 'bp-A-B-001.d.txt', units: [U('y', 1)] },
    ];
    assert.throws(() => assertUniqueNames(frags), PackError);
  });
});

// 分片名在本模块是**入参**：`layoutFragment` 只把它原样写进头部注释与 placements，不解析、不派生编号，
// 故下面几处取值是**示例**而非期望值。取值按 spec §4.3：常规片用点（`ue.NNN`），例外片用连字符（`ue-<Name>-NNN`）。
describe('emit: 分片渲染', () => {
  test('头部注释列出单元清单，正文逐字节等于单元文本拼接', () => {
    const a = U('Aa', 2), b = U('Bb', 1);
    const { text, name } = layoutFragment({ name: 'ue.001.d.txt', units: [a, b] });
    assert.equal(name, 'ue.001.d.txt');
    assert.ok(text.endsWith(a.text + b.text), '正文必须是单元原文拼接，不得改写');
    assert.match(text, /Aa/);
    assert.match(text, /Bb/);
  });

  test('placements 给出每个单元在分片内的 1-based 行号', () => {
    const a = U('Aa', 2), b = U('Bb', 1);
    const { text, placements } = layoutFragment({ name: 'ue.001.d.txt', units: [a, b] });
    const lines = text.split(/(?<=\n)/);
    assert.equal(placements.length, 2);
    for (const p of placements) {
      assert.equal(p.sliced, true);
      assert.equal(p.frag, 'ue.001.d.txt');
      assert.match(lines[p.line - 1], new RegExp(`(class|enum) ${p.unit.name}\\b`),
        `placements.line 与正文不符: ${p.unit.name} @ ${p.line}`);
    }
  });

  test('分片名与常量：FRAGMENTS_DIR 落在 Typing/ue/.fragments（tsc 不加载）', () => {
    assert.equal(FRAGMENTS_DIR, 'Typing/ue/.fragments');
  });
});

describe('emit: 孤儿清理严格限定在目标内', () => {
  const mkdir = () => mkdtempSync(join(tmpdir(), 'frag-'));

  test('只删目标前缀的孤儿，保留本次产出，不碰其他源', () => {
    const dir = mkdir();
    writeFileSync(join(dir, 'ue.001.d.txt'), '');
    writeFileSync(join(dir, 'ue.002.d.txt'), '');        // 孤儿
    writeFileSync(join(dir, 'ue-KismetMathLibrary-001.d.txt'), ''); // 孤儿
    writeFileSync(join(dir, 'bp-Game-001.d.txt'), '');   // 别的源
    writeFileSync(join(dir, 'decorators.001.d.txt'), ''); // 别的源
    writeFileSync(join(dir, 'manifest.jsonl'), '');      // 永不匹配

    const deleted = cleanOrphans(dir, 'ue', new Set(['ue.001.d.txt']));
    assert.deepEqual(deleted.sort(), ['ue-KismetMathLibrary-001.d.txt', 'ue.002.d.txt']);
    assert.deepEqual(readdirSync(dir).sort(), [
      'bp-Game-001.d.txt', 'decorators.001.d.txt', 'manifest.jsonl', 'ue.001.d.txt',
    ]);
  });

  test('无孤儿时不动任何文件', () => {
    const dir = mkdir();
    writeFileSync(join(dir, 'bp-Game-001.d.txt'), '');
    assert.deepEqual(cleanOrphans(dir, 'bp', new Set(['bp-Game-001.d.txt'])), []);
  });

  test('非 .d.txt 文件永不删除', () => {
    const dir = mkdir();
    writeFileSync(join(dir, 'bp-notes.md'), '');
    assert.deepEqual(cleanOrphans(dir, 'bp', new Set()), []);
  });

  test('decorators 的例外片名是连字符形，同样属于本目标、同样要清掉', () => {
    // 与 ue 同构：常规片 `decorators.NNN`（点），例外片 `decorators-<Name>-NNN`（连字符）。
    // 只认前者 => 陈旧的例外片永远不被删，且随后 --verify-only 会报它"前缀归属 0 个源"。
    const dir = mkdir();
    for (const n of [
      'decorators.001.d.txt',            // 本次产出
      'decorators-Foo-001.d.txt',        // 孤儿（例外片）
      'ue.001.d.txt', 'ue-Bar-001.d.txt', // 别的源：两种形态都不得被碰
      'bp-Game-001.d.txt',               // 别的源
    ]) writeFileSync(join(dir, n), '');

    const deleted = cleanOrphans(dir, 'decorators', new Set(['decorators.001.d.txt']));
    assert.deepEqual(deleted, ['decorators-Foo-001.d.txt']);
    assert.deepEqual(readdirSync(dir).sort(), [
      'bp-Game-001.d.txt', 'decorators.001.d.txt', 'ue-Bar-001.d.txt', 'ue.001.d.txt',
    ]);
  });
});

describe('manifest: 全量构建', () => {
  const placement = (unit, line) => ({ unit, frag: 'bp-Game-001.d.txt', line, sliced: true });

  test('JSONL：一行一记录，首行是 meta，绝不 minified 单行', () => {
    const meta = buildMeta({
      sources: [{ id: 'bp', path: 'Typing/ue/ue_bp.d.ts', sha1: 'abc', size: 1, mtime: 'T' }],
      threshold: 1800, now: '2026-09-12T00:00:00Z',
    });
    const rows = buildRows('bp', [placement(U('A', 1, { pkg: 'Game.X', root: 'Game' }), 3)]);
    const text = serialize(meta, rows);
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).__meta__, 1);
    assert.equal(JSON.parse(lines[1]).name, 'A');
  });

  test('meta 首行独立可解析，含全部源（逐源独立是分目标执行的基础）', () => {
    const meta = buildMeta({
      sources: [
        { id: 'ue', path: 'Typing/ue/ue.d.ts', sha1: 'u', size: 10, mtime: 'T1' },
        { id: 'bp', path: 'Typing/ue/ue_bp.d.ts', sha1: 'b', size: 20, mtime: 'T2' },
      ],
      threshold: 1800, now: '2026-09-12T00:00:00Z',
    });
    const first = JSON.parse(serialize(meta, []).split('\n')[0]);
    assert.equal(first.sources.length, 2);
    assert.deepEqual(first.sources.map((s) => s.id), ['ue', 'bp']);
    assert.equal(first.threshold, 1800);
  });

  test('symbol 行字段固定且完整；pkg/extends 为 null 时也写字段', () => {
    const rows = buildRows('ue', [{ unit: U('A', 1), frag: 'ue.001.d.txt', line: 5, sliced: true }]);
    assert.deepEqual(Object.keys(rows[0]),
      ['name', 'src', 'kind', 'pkg', 'extends', 'frag', 'line', 'sliced']);
    assert.equal(rows[0].pkg, null);
    assert.equal(rows[0].extends, null);
    assert.equal(rows[0].src, 'ue');
  });

  test('未切分源：sliced=false，frag 指向原文件，line 是原文件行号', () => {
    const rows = buildRows('puerts', [
      { unit: U('NewArray', 1), frag: 'Typing/ue/puerts.d.ts', line: 152, sliced: false },
    ]);
    assert.equal(rows[0].sliced, false);
    assert.equal(rows[0].frag, 'Typing/ue/puerts.d.ts');
    assert.equal(rows[0].line, 152);
  });

  test('同名不同类型产两行（name 不唯一）', () => {
    const rows = buildRows('puerts', [
      { unit: U('BuiltinBool', 1, { kind: 'type' }), frag: 'f.d.ts', line: 1, sliced: false },
      { unit: U('BuiltinBool', 1, { kind: 'const' }), frag: 'f.d.ts', line: 2, sliced: false },
    ]);
    assert.equal(rows.filter((r) => r.name === 'BuiltinBool').length, 2);
  });

  test('bp 行的 pkg / root 来自单元；ue 行 pkg 为 null', () => {
    const rows = buildRows('bp', [placement(U('A', 1, { pkg: 'Game.TopDown.B', root: 'Game' }), 3)]);
    assert.equal(rows[0].pkg, 'Game.TopDown.B');
    assert.equal(buildRows('ue', [{ unit: U('Z', 1), frag: 'ue.001.d.txt', line: 1, sliced: true }])[0].pkg, null);
  });

  test('parseManifest 回读：meta / rows 分离；损坏时 corrupt=true 且不抛', () => {
    const meta = buildMeta({ sources: [], threshold: 1800, now: 'T' });
    const text = serialize(meta, buildRows('ue', [{ unit: U('A', 1), frag: 'f', line: 1, sliced: true }]));
    const ok = parseManifest(text);
    assert.equal(ok.corrupt, false);
    assert.equal(ok.rows.length, 1);

    assert.equal(parseManifest('').corrupt, true);
    assert.equal(parseManifest('not json\n').corrupt, true);
    assert.equal(parseManifest('{"no":"sources"}\n').corrupt, true);
  });

  test('序列化确定性：同一输入两次得到逐字节相同的文本', () => {
    const meta = buildMeta({ sources: [], threshold: 1800, now: 'T' });
    const rows = buildRows('ue', [{ unit: U('A', 1), frag: 'f', line: 1, sliced: true }]);
    assert.equal(serialize(meta, rows), serialize(meta, rows));
  });

  test('META_VERSION 是常量', () => { assert.equal(META_VERSION, 1); });
});

const SRC = (id, sha1) => ({ id, path: `Typing/ue/${id}.d.ts`, sha1, size: 1, mtime: 'T' });
const row = (name, src) => ({ name, src, kind: 'class', pkg: null, extends: null, frag: 'f', line: 1, sliced: true });

describe('manifest: 读-改-写', () => {
  const prevOf = (sources, rows) => ({
    meta: { __meta__: 1, generated: 'T0', threshold: 1800, sources },
    rows, corrupt: false,
  });

  test('★增量不丢行：只重切 bp 时，ue 的行逐字段保留', () => {
    const prev = prevOf([SRC('ue', 'u1'), SRC('bp', 'b1')],
      [row('Actor', 'ue'), row('Object', 'ue'), row('BP_X', 'bp')]);
    const merged = mergeRows(prev.rows, new Set(['bp']),
      new Map([['bp', [row('BP_Y', 'bp')]]]), ['ue', 'bp']);
    assert.deepEqual(merged.map((r) => r.name), ['Actor', 'Object', 'BP_Y']);
    assert.deepEqual(merged.slice(0, 2), prev.rows.slice(0, 2), 'ue 的行必须逐字段不变');
  });

  test('★未处理源的 sha1 不被重算：沿用旧值，即使传入新算出的哈希', () => {
    const prev = prevOf([SRC('ue', 'OLD_UE'), SRC('bp', 'OLD_BP')], []);
    const merged = mergeMeta(prev.meta, [SRC('ue', 'NEW_UE'), SRC('bp', 'NEW_BP')],
      new Set(['bp']), 1800, 'T1');
    const byId = Object.fromEntries(merged.sources.map((s) => [s.id, s.sha1]));
    assert.equal(byId.ue, 'OLD_UE', '重算会掩盖"该源已漂移但本次未处理"，使下次增量判断失效');
    assert.equal(byId.bp, 'NEW_BP');
    assert.equal(merged.generated, 'T1');
  });

  test('threshold 变化 => 全部源视为 stale，强制全量（且无视 --target）', () => {
    const prev = prevOf([SRC('ue', 'u1'), SRC('bp', 'b1')], []);
    // targets 故意只给 bp：阈值变化改变的是**全部**分片边界。若这一支按 targets 收窄 stale，
    // 调用方（Task 7 按 plan.stale 重切）就会切出只剩 bp 行的 manifest —— 即 ★ 的静默丢行。
    const r = planRun({ prev, sources: [SRC('ue', 'u1'), SRC('bp', 'b1')],
      threshold: 2000, targets: ['bp'], force: false });
    assert.equal(r.mode, 'all');
    assert.deepEqual(r.stale.sort(), ['bp', 'ue']);
    assert.match(r.reason, /threshold/);
  });

  test('corrupt 且 meta 在位（版本不匹配经 parseManifest 折叠后的形态）=> 强制全量', () => {
    // parseManifest 对版本不匹配返回 {meta:null, corrupt:true}；本用例构造的是**手工 prev** 的
    // 第三种形态（meta 在位 + corrupt），用来单独钉住 planRun 的第三个析取项 `|| prev.corrupt`
    // —— 相邻用例只覆盖了 `!prev.meta` 那一项。planRun 里**没有**直接的版本判断。
    const prev = prevOf([SRC('ue', 'u1')], []);
    const r = planRun({ prev: { meta: prev.meta, rows: [], corrupt: true },
      sources: [SRC('ue', 'u1')], threshold: 1800, targets: null, force: false });
    assert.equal(r.mode, 'all');
    assert.deepEqual(r.stale, ['ue'], '强制全量必须标记**全部**源；只标部分会让调用方切出只剩部分源的 manifest');
  });

  test('manifest 缺失或损坏 => 全量', () => {
    for (const prev of [{ meta: null, rows: [], corrupt: true }, { meta: null, rows: [], corrupt: false }]) {
      const r = planRun({ prev, sources: [SRC('ue', 'u1')], threshold: 1800, targets: null, force: false });
      assert.equal(r.mode, 'all');
      assert.deepEqual(r.stale, ['ue']);
    }
  });

  test('★强制全量时忽略 --target：损坏的 manifest + --target bp 仍须标记全部源', () => {
    // 只标 bp 的后果不是"少切一个源"，而是**索引残缺**：Task 7 按 plan.stale 决定重切谁，
    // 于是产出的 manifest 只剩 bp 的行 —— 所有 ue / 引擎类符号静默消失，且不报任何错。
    // 强制全量的**每个**分支都必须无视 targets、返回**全部**源的 id
    //（本用例钉住"损坏 / 版本"这一支；"阈值变化"那一支由 threshold 用例钉住）。
    const r = planRun({ prev: { meta: null, rows: [], corrupt: true },
      sources: [SRC('ue', 'u1'), SRC('bp', 'b1'), SRC('decorators', 'd1')],
      threshold: 1800, targets: ['bp'], force: false });
    assert.equal(r.mode, 'all');
    assert.deepEqual(r.stale.slice().sort(), ['bp', 'decorators', 'ue']);
  });

  test('★mergeRows：stale 源未提供新行 => 响亮失败，不得静默丢行', () => {
    // 调用方若在决定"重切谁"时按 --target 过滤、却把未过滤的集合当 staleSet 传进来，
    // 旧行会先被丢弃（mergeRows 首个循环）、新行又不存在 —— 输出少行且毫无提示。
    // 本文件是全设计唯一会静默丢数据的地方，故此处**必须**抛错。
    assert.throws(
      () => mergeRows([row('Actor', 'ue')], new Set(['ue']), new Map(), ['ue']),
      /未提供新行/,
    );
    // 反面一：空数组是**合法**的新行集（"确实切出了 0 条行"），必须放行而不误抛。
    // 但这条**不足以**钉住 Array.isArray 与真值判断的区别 —— `Boolean([])` 为 true，
    // 真值判断同样放行它。真正钉住该区别的是下面"真值但非数组"那条。
    assert.deepEqual(mergeRows([row('Old', 'ue')], new Set(['ue']), new Map([['ue', []]]), ['ue']), []);
    // 反面二：**真值但非数组**。字符串是真值且**可迭代** —— 真值判断会放行，随后 `...spread`
    // 把 `'oops'` 展成 `["o","o","p","s"]`，静默写进 4 条垃圾行（比抛 TypeError 更糟）。
    // 没有这条，把判据从 Array.isArray 改回 `!get(id)` 仍能让全套测试保持全绿。
    assert.throws(
      () => mergeRows([row('Actor', 'ue')], new Set(['ue']), new Map([['ue', 'oops']]), ['ue']),
      /未提供新行/,
    );
  });

  test('增量：只重切 sha1 不匹配的源；已最新的源不进 stale', () => {
    const prev = prevOf([SRC('ue', 'u1'), SRC('bp', 'OLD')], []);
    const r = planRun({ prev, sources: [SRC('ue', 'u1'), SRC('bp', 'NEW')],
      threshold: 1800, targets: null, force: false });
    assert.equal(r.mode, 'partial');
    assert.deepEqual(r.stale, ['bp']);
  });

  test('--target 列出但未漂移 => 跳过（除非 --force）', () => {
    const prev = prevOf([SRC('ue', 'u1'), SRC('bp', 'b1')], []);
    const args = { prev, sources: [SRC('ue', 'u1'), SRC('bp', 'b1')], threshold: 1800, targets: ['bp'] };
    assert.deepEqual(planRun({ ...args, force: false }).stale, []);
    assert.deepEqual(planRun({ ...args, force: true }).stale, ['bp']);
  });

  test('新增源（meta 中不存在）=> 仅该源 stale', () => {
    const prev = prevOf([SRC('ue', 'u1')], []);
    const r = planRun({ prev, sources: [SRC('ue', 'u1'), SRC('decorators', 'd1')],
      threshold: 1800, targets: null, force: false });
    assert.deepEqual(r.stale, ['decorators']);
  });

  test('行序：输出按 order 分组，与 prev 中的交错顺序无关', () => {
    const prev = prevOf([SRC('ue', 'u1'), SRC('bp', 'b1'), SRC('decorators', 'd1')],
      [row('A', 'ue'), row('B', 'bp'), row('C', 'ue'), row('D', 'decorators')]);
    const merged = mergeRows(prev.rows, new Set(['bp']),
      new Map([['bp', [row('B2', 'bp')]]]), ['ue', 'bp', 'decorators']);
    // ue 的两行必须聚在一起 —— 否则 manifest 字节内容会随处理顺序漂移，无法逐字节比对
    assert.deepEqual(merged.map((r) => r.name), ['A', 'C', 'B2', 'D']);
  });

  test('多源同时 stale：新行按 order 分组，与 newRowsBySrc 的插入顺序无关', () => {
    const prev = prevOf([SRC('ue', 'u1'), SRC('bp', 'b1')], [row('A', 'ue')]);
    // Map 故意按 bp→ue 插入：若实现沿用 Map 的插入顺序，结果会是 ['B','A2'] 而失败
    const merged = mergeRows(prev.rows, new Set(['ue', 'bp']),
      new Map([['bp', [row('B', 'bp')]], ['ue', [row('A2', 'ue')]]]), ['ue', 'bp']);
    assert.deepEqual(merged.map((r) => r.name), ['A2', 'B']);
  });
});

const CLI = join(HERE, '..', 'split-dts.mjs');
const PROJECT = join(HERE, 'fixtures', 'mini-project');
/**
 * 集成测试一律用小阈值：fixture 是几十行，只有小到 15 才切得出多片、例外片与孤儿。
 * 取 **15 而非 12** 是有理由的：bp 单元是 7 行，只有 >= 14 才能让 Game 的两个单元同处一片，
 * 从而在集成层面真正走到"逐 root 分段"分支（12 时每片恰好一个单元，该分支不会被覆盖）。
 */
const TH = '15';

/** 每个用例在临时目录里跑，避免互相污染；返回该目录 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'splitdts-'));
  cpSync(PROJECT, dir, { recursive: true });
  return dir;
}
const run = (dir, ...args) =>
  spawnSync(process.execPath, [CLI, '--project', dir, '--no-verify', '--threshold', TH, ...args],
    { encoding: 'utf8' });
const fragDir = (dir) => join(dir, 'Typing', 'ue', '.fragments');
const manifestText = (dir) => rf(join(fragDir(dir), 'manifest.jsonl'), 'utf8');
/**
 * `.fragments/` **整目录**的 [名, 内容] 快照，按名排序 —— 用于"逐字节相同"类断言。
 * ⚠️ **未过滤**：它**含 `manifest.jsonl`**（不只是 `.d.txt`）。需要只比分片时，在**调用处**
 * 按名排除 manifest（见确定性用例）；**不要在本函数里过滤** —— `半更新不留存` 用例正需要
 * 连 manifest 一起比（那次运行在写盘前抛错，整目录理应逐字节不变，是更强的断言）。
 */
const snapFrags = (dir) =>
  readdirSync(fragDir(dir)).sort().map((f) => [f, rf(join(fragDir(dir), f), 'utf8')]);

describe('cli: 全量与增量', () => {
  test('无 manifest => 全量，产出 .fragments/ 与 manifest.jsonl', () => {
    const dir = sandbox();
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(fragDir(dir), 'manifest.jsonl')));
    assert.ok(readdirSync(fragDir(dir)).some((f) => f.endsWith('.d.txt')));
  });

  test('.fragments/ 内不得出现 .ts / .d.ts（会污染 tsc）', () => {
    const dir = sandbox();
    run(dir);
    for (const f of readdirSync(fragDir(dir))) {
      assert.ok(!f.endsWith('.ts'), `禁止出现 ${f}`);
      assert.ok(!f.endsWith('.d.ts'), `禁止出现 ${f}`);
    }
  });

  test('确定性：连跑两次，分片逐字节相同、manifest 除 generated 外逐字段相同', () => {
    const dir = sandbox();
    run(dir);
    // 只比"分片"本身。`snapFrags` 是**未过滤**的整目录快照，**含 `manifest.jsonl` 的原始字节**，
    // 而 manifest 的 meta 首行带挂钟 `generated`（每次落盘必变）—— 直接比会把上一条刚排除掉的
    // 字节比较**经由目录快照原样请回来**（本用例第一版正是这样漏掉的）。manifest 的内容由下面
    // 两条断言单独负责；此处按名排除它，**其余一切（含任何意外多出的文件）仍逐字节比**。
    // **不能改 `snapFrags` 本身**：`半更新不留存` 用例正需要整目录（含 manifest）逐字节不变。
    const products = (d) => snapFrags(d).filter(([f]) => f !== 'manifest.jsonl');
    const productsBefore = products(dir);
    const a = parseManifest(manifestText(dir));
    const r = run(dir, '--all');
    assert.equal(r.status, 0);
    // 分片集：全量重切后必须逐字节相同 —— 这条才真正钉住"排序稳定、不依赖哈希迭代序"
    assert.deepEqual(products(dir), productsBefore);
    const b = parseManifest(manifestText(dir));
    // 索引行：两侧都是全量，行集必须完全一致
    assert.deepEqual(b.rows, a.rows);
    // meta：**除 generated 外逐字段相同**，含 __meta__ / threshold / 每个源的 sha1 / size / path / mtime。
    // **不能整份逐字节比**：generated 是本次落盘的挂钟时刻（manifest.mjs 的 mergeMeta 写 `now`），
    // 按定义不是输入的函数（spec §7"确切范围"注）。本用例传了 --all => 全部源判定为 stale
    // => 走写盘分支（不写盘的是 main 里"全量已是最新"的提前返回，本用例到不了那里），
    // 故两次落盘时刻必然不同；而 mtime 取自同一棵沙箱内未被改动的源文件，必须完全相同。
    const { generated: ga, ...metaA } = a.meta;
    const { generated: gb, ...metaB } = b.meta;
    assert.deepEqual(metaB, metaA);
    // 反向钉住：generated 必须仍在且是可解析的时间戳 —— 防止有人靠"删掉这个字段"让上面几条变绿
    for (const g of [ga, gb]) assert.ok(!Number.isNaN(Date.parse(g)), `generated 不是时间戳: ${g}`);
  });

  test('fixture 的形状：多片、例外片、多 root、三套前缀（否则上面几条是空测）', () => {
    const dir = sandbox();
    run(dir, '--all');
    const names = readdirSync(fragDir(dir)).filter((f) => f.endsWith('.d.txt')).sort();
    assert.deepEqual(names, [
      // bp：Game 的两个单元（14 行）同处一片 -> 真的走到了"逐 root 分段"；
      // Niagara 另起一片且拿到 **002** -> 序号是跨 root 的单一计数器
      'bp-Game-001.d.txt', 'bp-Niagara-002.d.txt',
      // decorators：4 个 class 切两片 -> 孤儿清理测试有第二片可保护
      'decorators.001.d.txt', 'decorators.002.d.txt',
      // ue：常规片占 001/002，例外片拿 003/004 —— 序号是**单一计数器**（`nameFragments` 里
      // 常规与例外**共用一个 n**，按 pack 产出的分组顺序递增），而 UE_XXL 按声明名排序在
      // UE_C* **之后**，故例外片排在后面。（Task 3 的 `ue-Big-001..003` + `ue.004` 是同一规则
      // 的另一侧：`Big` 按名排序在其它单元之前。两侧合起来才钉住"单一计数器"。）
      'ue-UE_XXL-003.d.txt', 'ue-UE_XXL-004.d.txt', 'ue.001.d.txt', 'ue.002.d.txt',
    ], `未切出预期的分片集: ${names}`);
  });

  test('增量：无参数第二次运行跳过已最新的源', () => {
    const dir = sandbox();
    run(dir);
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /unchanged|skipped/i);
  });

  test('--target bp --force 只动 bp 相关分片', () => {
    const dir = sandbox();
    run(dir);
    const ueFrags = snapFrags(dir).filter(([f]) => /^ue[.-]/.test(f));
    const r = run(dir, '--target', 'bp', '--force');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapFrags(dir).filter(([f]) => /^ue[.-]/.test(f)), ueFrags,
      'ue 分片连内容都不得变 —— 只比文件名会漏掉"被重切后覆盖"');
  });

  test('--help 退出 0 并列出全部参数', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    for (const flag of ['--target', '--all', '--force', '--project', '--threshold', '--verify-only', '--no-verify', '--help']) {
      assert.match(r.stdout, new RegExp(flag.replace(/-/g, '\\-')), `--help 未列出 ${flag}`);
    }
  });

  test('未知参数 => 非 0 退出并给出用法', () => {
    const r = spawnSync(process.execPath, [CLI, '--nope'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--help|用法|usage/i);
  });

  test('★未知源 id => 非 0 退出并列出可选 id（planRun 对未知 target 静默 no-op，唯一防线在此）', () => {
    // planRun 收到不在 SOURCES 里的 target 时**不报错**，只是把它从 pool 里过滤掉 ⇒ stale 为空
    // ⇒ CLI 走"所有源均为最新"提前返回、退出 0。用户以为重切了 ue，其实什么都没做。
    // 故 parseArgs 的 id 白名单是唯一防线，必须有测试钉住（Task 6 评审 F7 的残留项）。
    const r = spawnSync(process.execPath, [CLI, '--target', 'bogus'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /未知源 id/);
    assert.match(r.stderr, /bogus/, '失败信息必须点名用户写错的那个 id');
  });

  test('★空 --target（空串 / 裸参数 / 仅逗号）=> 非 0 退出，绝不静默跳过', () => {
    // 与上一条**同源**：`[]` 是真值 ⇒ `if (a.targets)` 放行 ⇒ 白名单跑 0 次 ⇒ planRun 收到空 pool
    // ⇒ stale 为空 ⇒ 提前返回、退出 0、打印"所有源均为最新"。裸 `--target`（缺值）与仅逗号同理。
    // 实测（Task 7 评审）：改动 ue.d.ts 后跑 `--target ""`，输出 "unchanged — skipped" 且 EXIT=0 ——
    // 用户以为重切了，实际什么都没做还报成功。故三种写法都必须响亮失败。
    for (const args of [['--target', ''], ['--target'], ['--target', ',']]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
      assert.notEqual(r.status, 0, `${args.join(' ')} 必须非 0 退出；实际 stdout=${r.stdout}`);
      assert.match(r.stderr, /--target/, '失败信息必须点名 --target');
    }
  });

  test('项目根不存在 => 非 0 退出，不静默造目录', () => {
    const r = spawnSync(process.execPath, [CLI, '--project', join(tmpdir(), 'nope-does-not-exist')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
  });

  test('findProjectRoot 向上找到含 tsconfig.json 的目录', () => {
    const dir = sandbox();
    assert.equal(findProjectRoot(join(dir, 'Typing', 'ue')), dir);
    assert.equal(findProjectRoot(join(dir, 'Typing', 'ue', '.fragments')), dir);
  });

  test('★findProjectRoot 找不到时列出**尝试过的候选目录**（spec §5.5：查不到则响亮失败并列出候选）', () => {
    // 起始目录埋进沙箱内 4 层深：被探测的 4 个祖先**全部落在沙箱内**（第 5 层那个含
    // tsconfig.json 的沙箱根够不着），故本判据与"机器上某个祖先碰巧有 tsconfig.json"
    // 无关 —— 确定性来自构造，不来自环境。
    const dir = sandbox();
    const deep = join(dir, 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    const probed = [deep, join(dir, 'a', 'b', 'c'), join(dir, 'a', 'b'), join(dir, 'a')];

    let msg = '';
    assert.throws(() => findProjectRoot(deep), (e) => { msg = e.message; return true; });
    for (const p of probed) {
      assert.ok(msg.includes(p), `报错必须列出探测过的候选目录 ${p}（只报起始目录不足以定位），实得：${msg}`);
    }
    assert.ok(msg.includes(deep), '起始目录同样要在报错里');
    assert.ok(msg.includes('--project'), '必须给出补救方式（用 --project 显式指定项目根）');
  });
});

describe('cli: 半更新不留存', () => {
  test('某个源解析失败时，manifest 完全未被写入', () => {
    const dir = sandbox();
    run(dir);
    const before = manifestText(dir);
    const fragsBefore = snapFrags(dir);

    // 破坏 bp：删掉第一个结束标记。无论实现把它当成"未闭合对"还是"标记对数 != 单元数"，
    // 都必须在**写盘之前**抛错（spec §7 半更新不留存）
    const bpPath = join(dir, 'Typing', 'ue', 'ue_bp.d.ts');
    wf(bpPath, rf(bpPath, 'utf8').replace(/\/\/ __TYPE_DECL_END\n/, ''));

    const r = run(dir, '--all');
    assert.notEqual(r.status, 0, '必须响亮失败');
    assert.match(r.stderr, /bp|标记|单元/, '失败信息必须指明是哪个源');
    assert.equal(manifestText(dir), before, 'manifest 必须逐字节不变');
    assert.deepEqual(snapFrags(dir), fragsBefore, '分片也必须逐字节不变（写盘全部发生在末尾）');
  });
});

describe('verify: 内容级校验', () => {
  test('完整性：sha1(排序后单元文本) 相等 => 通过', () => {
    const units = [U('A', 2), U('B', 3)];
    assert.equal(checkContentIntegrity(units, units.slice().reverse()).ok, true);
  });

  test('完整性：少一个单元 => 失败（分片重排后无法用行号回验，只能比内容）', () => {
    const units = [U('A', 2), U('B', 3)];
    const r = checkContentIntegrity(units, [units[0]]);
    assert.equal(r.ok, false);
    assert.match(r.detail, /单元数|sha1/);
  });

  test('完整性：单元文本被改写 => 失败', () => {
    const units = [U('A', 2)];
    const tampered = [{ ...units[0], text: 'zzz\nzzz\n' }];
    assert.equal(checkContentIntegrity(units, tampered).ok, false);
  });

  test('片长：多单元分片超阈值 => 失败；恰好等于阈值 => 通过', () => {
    assert.equal(checkFragmentLength([{ name: 'ue.001.d.txt', units: [U('A', 6), U('B', 6)] }], 10).ok, false);
    assert.equal(checkFragmentLength([{ name: 'ue.001.d.txt', units: [U('A', 5), U('B', 5)] }], 10).ok, true);
  });

  test('片长：单单元超阈值是例外分支，**必须豁免**（否则正常产出被判失败）', () => {
    assert.equal(checkFragmentLength([{ name: 'ue-XXL-001.d.txt', units: [U('XXL', 30)] }], 10).ok, true);
  });

  test('编译隔离：.fragments/ 内有 .d.ts => 失败', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frag-'));
    writeFileSync(join(dir, 'ue.001.d.txt'), '');
    assert.equal(checkCompileIsolation(dir).ok, true);
    writeFileSync(join(dir, 'leak.d.ts'), '');
    const r = checkCompileIsolation(dir);
    assert.equal(r.ok, false);
    assert.match(r.detail, /leak\.d\.ts/);
  });
});

describe('verify: manifest 一致性', () => {
  /** 造一个落盘分片；line 是 1-based 的单元起始行 */
  const fixture = (fragName, lines) => {
    const root = mkdtempSync(join(tmpdir(), 'mf-'));
    const dir = join(root, 'Typing', 'ue', '.fragments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fragName), lines.join('\n') + '\n');
    return root;
  };
  const rowOf = (over) => ({
    name: 'X', src: 'ue', kind: 'class', pkg: null, extends: null,
    frag: 'ue.001.d.txt', line: 1, sliced: true, ...over,
  });

  test('常规片：line 指向单元首行，名字就在该行', () => {
    const root = fixture('ue.001.d.txt',
      ['// ue.001.d.txt — 2 unit(s)', '// class A', '// class B', '',
        '    class A {', '    }', '    class B {', '    }', '']);
    const rows = [rowOf({ name: 'A', line: 5 }), rowOf({ name: 'B', line: 7 })];
    assert.equal(checkManifestConsistency(root, rows).ok, true);
  });

  test('★bp 片：line 指向 START 标记行（该行不含类型名），名字在其下方 —— 窗口查找必须命中', () => {
    // 这正是"按单行严格比对"会误判的形态：bp 单元首行是标记，往下才是 namespace/class
    const root = fixture('ue.001.d.txt',
      ['// ue.001.d.txt — 1 unit(s)', '// class BP_Boss_C', '',
        '// __TYPE_DECL_START: 5.7', '    namespace Game.Boss {',
        '        class BP_Boss_C {', '        }', '    }', '']);
    const rows = [rowOf({ name: 'BP_Boss_C', pkg: 'Game.Boss', line: 4 })];
    assert.equal(checkManifestConsistency(root, rows).ok, true);
  });

  test('名字在窗口内找不到 => 失败；行号越界 => 失败；重复 (frag,line) => 失败', () => {
    const lines = ['// h', '', '    class A {', '    }', ''];
    const root = fixture('ue.001.d.txt', lines);
    assert.equal(checkManifestConsistency(root, [rowOf({ name: 'Nope', line: 3 })]).ok, false);
    assert.equal(checkManifestConsistency(root, [rowOf({ name: 'A', line: 999 })]).ok, false);

    const dup = fixture('ue.001.d.txt', lines);
    const rd = checkManifestConsistency(dup, [rowOf({ name: 'A', line: 3 }), rowOf({ name: 'A', line: 3 })]);
    assert.equal(rd.ok, false);
    // 必须由**重复判据本身**报出。只断言 ok===false 是**假绿**：重复行中先到的那一轮
    // 窗口是空的，会以"找不到 name"返回，删掉重复判据用例照样通过。
    assert.match(rd.detail, /重复/, '重复 (frag,line) 应由专门判据报出，而非空窗口的误伤');
  });

  test('manifest 指向不存在的文件 => 失败', () => {
    const root = fixture('ue.001.d.txt', ['// h', '']);
    assert.equal(checkManifestConsistency(root, [rowOf({ name: 'A', frag: 'nope.d.txt', line: 1 })]).ok, false);
  });

  test('★单元级例外：同一符号被切成多片时，续片按片头注释校验（行号窗口对续片恒不命中）', () => {
    // ue 的例外分支把**单个超阈值单元**拆进多个分片 ⇒ 续片正文里不重复类型名（名字只在片头注释）。
    // 若按常规行处理，合法产出被判失败；而每次落盘后都跑 runChecks ⇒ 整个 CLI 恒退出 1。
    const mk = (secondHeader) => {
      const root = mkdtempSync(join(tmpdir(), 'mf-'));
      const dir = join(root, 'Typing', 'ue', '.fragments');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ue-XXL-001.d.txt'),
        ['// ue-XXL-001.d.txt — 1 unit(s)', '// class XXL', '', '    class XXL {', '    }', ''].join('\n'));
      writeFileSync(join(dir, 'ue-XXL-002.d.txt'),
        ['// ue-XXL-002.d.txt — 1 unit(s)', `// class ${secondHeader}`, '', '        p1: number;', '    }', ''].join('\n'));
      return root;
    };
    const rows = [
      rowOf({ name: 'XXL', frag: 'ue-XXL-001.d.txt', line: 4 }),
      rowOf({ name: 'XXL', frag: 'ue-XXL-002.d.txt', line: 4 }),
    ];

    // 正例：首片正文含名字、续片只有片头注释含名字 —— 必须通过
    assert.equal(checkManifestConsistency(mk('XXL'), rows).ok, true);
    // 反向钉：把续片的片头注释换成别的名字 ⇒ 必须失败。这证明松绑**只到片头注释为止**，
    // 不是"名字在片内任意位置出现即可"（后者会让常规行的行号约束整体作废）。
    // 断言**失败原因**而不只是 ok===false：否则任何无关失败都会让这条继续绿。
    const rOther = checkManifestConsistency(mk('OTHER'), rows);
    assert.equal(rOther.ok, false);
    assert.match(rOther.detail, /片头注释/, '必须由"片头注释里找不到"这条判据报出，而非别的失败');
  });

  test('★名字以 `$` 开头时词边界判据失效：窗口必须按标识符字符类界定，且不得匹配更长的标识符', () => {
    // 实测真实 `Typing/ue/puerts.d.ts` 第 11 行 `interface $CallbackID {}`。`\b` 只认 `\w`，
    // 而 `$` 不是 \w —— `\b$CallbackID\b` 要求 `$` 之前有词边界，但 `$` 与它前面的空格
    // **都不是 \w** ⇒ 词边界不存在 ⇒ **恒不命中** ⇒ 合法产出被判失败。
    // fixture 里没有任何 `$` 开头的符号，故该缺陷只在真实数据上现形（实测共 10 行）。
    const root = fixture('ue.001.d.txt',
      ['// h', '', '    interface $CallbackID {}', '    interface $Delegate<T> {', '    }', '']);
    const rows = [
      rowOf({ name: '$CallbackID', kind: 'interface', line: 3 }),
      rowOf({ name: '$Delegate', kind: 'interface', line: 4 }),
    ];
    assert.equal(checkManifestConsistency(root, rows).ok, true);

    // 反向钉：环视必须挡住**超串** —— 片内只有 `$Reference` 时 `$Ref` 不得通过。
    // 若把边界整体删成裸子串匹配，这条会变红。
    const root2 = fixture('ue.001.d.txt', ['// h', '', '    const $Reference = 1;', '']);
    assert.equal(checkManifestConsistency(root2, [rowOf({ name: '$Ref', kind: 'const', line: 3 })]).ok, false);
  });

  test('★同名重载不得被当成"被切片"：chunked 按分片集合计数，不按行数', () => {
    // 实测真实 `Typing/puerts/index.d.ts` 的 `toDelegate` 在第 74、76 行各一行 —— 同一文件的
    // **两个重载**，不是被单元级例外切开的续片。按"同名行数 > 1"判定会把重载误判成"被切片"，
    // 转而要求片头注释 `// function toDelegate`；而该源 `sliced:false`（"分片"就是源文件本身），
    // **根本没有片头注释** ⇒ 合法产出被判失败。按分片集合计数则重载落回窗口校验，而窗口
    // 本来就能覆盖重载（每个重载行到自己下一个符号之间必含自己的名字）。
    // 这条用例的 fixture 刻意**不含任何片头注释行**，正是为了让"误判成被切片"的实现在此变红。
    const root = fixture('ue.001.d.txt',
      ['    function toDelegate(f: number): void;', '    function toDelegate(s: string): void;', '']);
    const rows = [
      rowOf({ name: 'toDelegate', kind: 'function', line: 1 }),
      rowOf({ name: 'toDelegate', kind: 'function', line: 2 }),
    ];
    assert.equal(checkManifestConsistency(root, rows).ok, true);
  });

  test('★全局松绑探测器：非被切片的行**不得**因片头注释里有名字而通过', () => {
    // 这条钉的是 `chunked` 的**判别力**，不是它的某个具体实现。
    // 若判据被放宽（例如 `> 1` 误写成 `>= 1`），**每一条**常规行都会改走片头分支，
    // 行号窗口校验整体变成死代码 —— 而**全套用例仍会全绿**：`★bp 片` 那条的片头恰好是
    // `// class BP_Boss_C`，走片头分支同样能通过。所以必须专门造一个
    // "片头注释里有名字、但窗口内没有"的**非被切片**行，正确实现必须判红。
    const root = fixture('ue.001.d.txt',
      ['// ue.001.d.txt — 1 unit(s)', '// class Ghost', '', '    class A {', '    }', '']);
    const r = checkManifestConsistency(root, [rowOf({ name: 'Ghost', kind: 'class', line: 4 })]);
    assert.equal(r.ok, false, '名字只在片头注释里、窗口内没有 ⇒ 必须失败');
    assert.match(r.detail, /找不到 name/, '必须由窗口判据报出，而不是被片头分支放行');
  });

  test('重复判据键在 (frag,line)：**不同名**同一行也必须被抓', () => {
    // 前置扫描只比 line、不比 name（键里已有 name 的是"被切片"判据，不是这条）。
    // 补一条不同名的同 (frag,line) 重复，防止将来有人把判据改成"同名才算重复"而用例无感。
    const root = fixture('ue.001.d.txt', ['// h', '', '    class A {', '    }', '']);
    const rd = checkManifestConsistency(root, [
      rowOf({ name: 'A', line: 3 }), rowOf({ name: 'B', line: 3 }),
    ]);
    assert.equal(rd.ok, false);
    assert.match(rd.detail, /重复/);
  });
});

describe('§7 分目标增量专属检查', () => {
  test('checkPackageNotSplit：总量 <= 阈值的 package 跨片必须失败；超阈值者豁免', () => {
    const u = (name, lines, pkg) => ({ name, pkg, lines, text: '' });
    const frag = (name, units) => ({ name, src: 'bp', units });
    const straddling = [
      frag('bp-Game-001.d.txt', [u('A', 6, 'Game.P')]),
      frag('bp-Game-002.d.txt', [u('B', 4, 'Game.P')]),
    ];
    // 总量 10 <= 阈值 14 => 这是真跨片（§4.3 的硬约束被破坏）
    assert.equal(checkPackageNotSplit(straddling, 14).ok, false);
    // 同一份输入，阈值降到 8 => 总量 10 > 8，走 §4.3 例外分支 => 豁免
    assert.equal(checkPackageNotSplit(straddling, 8).ok, true);
    // 总量 <= 阈值且不跨片 => 通过
    assert.equal(checkPackageNotSplit([frag('bp-Game-001.d.txt', [u('A', 6, 'Game.P')])], 14).ok, true);
  });

  test('增量等价性：分目标增量重切 == 一次性全量（索引与分片逐字节）', () => {
    const a = sandbox(); const b = sandbox();
    // 两边先各建一次 manifest。**不能直接跑 --target**：manifest 缺失时 planRun 走强制全量分支，
    // 而该分支**无视 --target**（Task 6 的 ★ 用例已钉住这一点），于是本条会退化成
    // "全量是确定的"，与 Task 7 的确定性用例重复 —— 增量路径一步都没走到。
    run(a, '--all'); run(b, '--all');

    // 制造真实的 sha1 漂移（三个可切分源 + 一个 sliced:false 源）。只追加一个换行，
    // 不改变任何单元，故两侧的期望分片集完全相同；后面**不加 --force**，
    // 靠漂移检测选中它们，顺带覆盖"sliced:false 源的增量路径"。
    for (const d of [a, b]) {
      for (const rel of ['ue.d.ts', 'ue_bp.d.ts', 'puerts_decorators.d.ts', 'puerts.d.ts']) {
        const p = join(d, 'Typing', 'ue', rel);
        wf(p, rf(p, 'utf8') + '\n');
      }
    }

    run(a, '--all');
    run(b, '--target', 'ue');
    run(b, '--target', 'bp');
    run(b, '--target', 'decorators');
    run(b, '--target', 'puerts,puerts-index,ffi,cpp,ue-index');

    // ⚠️ **不能整份 manifest 逐字节比**：meta 首行的 `generated` 是本次落盘时刻，每写一次就变；
    // `sources[].mtime` 是源文件的拷贝时刻，而本用例是**跨两棵沙箱树**比较（cpSync 不保留
    // 时间戳），mtime 必然不同。二者都不是被测属性 —— spec §7"确切范围"注写明：跨树比较只比
    // threshold 与每源 sha1，该放宽**不适用于**同树连跑两次的确定性检查（那里 mtime 必须相同）。
    // 被比的是**索引内容**（行）与**每源 sha1**（应收敛到同一最终状态）。
    const parts = (d) => {
      const ls = manifestText(d).trimEnd().split('\n');
      const meta = JSON.parse(ls[0]);
      return {
        rows: ls.slice(1),
        threshold: meta.threshold,
        sha1BySrc: Object.fromEntries(meta.sources.map((s) => [s.id, s.sha1])),
      };
    };
    assert.deepEqual(parts(b), parts(a));

    // 只比"分片"本身。`snapFrags` 是**未过滤**的整目录快照（其定义处的 ⚠️ 已写明），
    // 而本用例是**跨两棵沙箱树**比较：manifest 里的 `generated` 是本次落盘时刻、
    // `sources[].mtime` 是源文件拷贝时刻（cpSync 不保留时间戳），二者必然不同，
    // 且都不是被测属性 —— 索引行与每源 sha1 已在上一条 `parts` 断言里单独比过。
    // **复用既有 helper 并在调用处过滤**，不就地重写：就地重写正是漏掉这层过滤的原因，
    // 且会与 `snapFrags` 的函数体逐字重复。
    const snap = (d) => snapFrags(d).filter(([f]) => f !== 'manifest.jsonl');
    assert.deepEqual(snap(b), snap(a));
  });

  test('★增量不丢行（端到端）：--target bp 后 ue 的行逐字节不变', () => {
    const dir = sandbox(); run(dir, '--all');
    const ueRowsBefore = manifestText(dir).split('\n').filter((l) => l.includes('"src":"ue"'));
    assert.ok(ueRowsBefore.length > 0, 'fixture 必须产出 ue 行');
    run(dir, '--target', 'bp', '--force');
    const ueRowsAfter = manifestText(dir).split('\n').filter((l) => l.includes('"src":"ue"'));
    assert.deepEqual(ueRowsAfter, ueRowsBefore);
  });

  test('★孤儿清理不越界：--target bp 后 ue/decorators 分片集合完全不变', () => {
    const dir = sandbox(); run(dir, '--all');
    const before = readdirSync(fragDir(dir)).filter((f) => /^(ue[.-]|decorators\.)/.test(f)).sort();
    run(dir, '--target', 'bp', '--force');
    assert.deepEqual(readdirSync(fragDir(dir)).filter((f) => /^(ue[.-]|decorators\.)/.test(f)).sort(), before);
  });

  test('★未处理源的 sha1 不被重算（端到端）', () => {
    const dir = sandbox(); run(dir, '--all');
    const ueBefore = JSON.parse(manifestText(dir).split('\n')[0]).sources.find((s) => s.id === 'ue').sha1;
    // 改 ue.d.ts 但不处理它
    const p = join(dir, 'Typing', 'ue', 'ue.d.ts');
    wf(p, rf(p, 'utf8') + '\n');
    run(dir, '--target', 'bp', '--force');
    const ueAfter = JSON.parse(manifestText(dir).split('\n')[0]).sources.find((s) => s.id === 'ue').sha1;
    assert.equal(ueAfter, ueBefore, '重算会掩盖漂移，使下次增量判断失效');
  });

  test('孤儿真被清理：删掉一个源的类型后重切，其旧分片消失', () => {
    const dir = sandbox(); run(dir, '--all');
    const bpPath = join(dir, 'Typing', 'ue', 'ue_bp.d.ts');
    wf(bpPath, rf(bpPath, 'utf8').replace(/\n\/\/ __TYPE_DECL_START: 5\.7\n    namespace Niagara[\s\S]*?__TYPE_DECL_END\n/, '\n'));
    run(dir, '--target', 'bp', '--force');
    const rows = manifestText(dir).split('\n').filter((l) => l.includes('"src":"bp"'));
    assert.ok(!rows.some((l) => l.includes('FPyObject')), '被删类型不得残留');
    const names = rows.map((l) => JSON.parse(l).frag);
    for (const n of new Set(names)) assert.ok(existsSync(join(fragDir(dir), n)), `manifest 指向的分片不存在: ${n}`);
  });

  test('runChecks 在 --verify-only 下执行全部 9 项', () => {
    const dir = sandbox(); run(dir, '--all');
    const r = spawnSync(process.execPath, [CLI, '--project', dir, '--verify-only'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // 必须钉住**新的**汇总形态（三数）。只断言 /自检通过/ 的话，Task 8 的两数版
    // （自检通过（N 个符号））也会通过 —— 实测：拿本测试文件去跑 Task 8 的 runChecks，这条全绿。
    assert.match(r.stdout, /自检通过（\d+ 个符号 \/ \d+ 个单元 \/ \d+ 个分片）/);
  });

  test('编译隔离被 --verify-only 捕获：塞一个 .d.ts 进 .fragments/', () => {
    const dir = sandbox(); run(dir, '--all');
    wf(join(fragDir(dir), 'leak.d.ts'), '');
    const r = spawnSync(process.execPath, [CLI, '--project', dir, '--verify-only'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /leak\.d\.ts/);
  });

  test('★完整性被 --verify-only 捕获：只改片内正文，符号名原封不动', () => {
    // 这条专门证明"内容级校验"不是摆设：只坏内容、不动符号名，
    // 于是 checkManifestConsistency 无从发现，只有 sha1 比对能抓住
    const dir = sandbox(); run(dir, '--all');
    const f = readdirSync(fragDir(dir)).find((n) => n.startsWith('ue.'));
    assert.ok(f, 'fixture 应产出 ue.NNN 常规片');
    const p = join(fragDir(dir), f);
    const before = rf(p, 'utf8');
    wf(p, before.replace('p0: number;', 'p0: string;'));
    assert.notEqual(rf(p, 'utf8'), before, '篡改必须真的生效，否则这条是空测');

    const r = spawnSync(process.execPath, [CLI, '--project', dir, '--verify-only'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /完整性/);
  });

  test('★任一源文件缺失都不得被静默跳过：判据按 SOURCES **逐源**遍历，缺谁都必须非 0 退出并指名谁', () => {
    // 旧行为实测：删掉 `Typing/ue/ue.d.ts` 后 --verify-only 照样打印「自检通过（…）」并**退出 0**
    // （该源的单元/分片根本没被检查），而同一棵树走切分路径则报 `源文件不存在` 退出 1 ——
    // 两条路径对"源集合"口径不一致，绿色侧正是本计划要根除的那类假绿。
    //
    // 判据**按 SOURCES 遍历**、不写死具体源，因为"缺源被静默跳过"是一**类**洞而不是一个实例：
    // 第一版只钉了 ue（切片源），于是漏掉了 `parser: 'none'` 的源 —— 它在循环开头被
    // `parser === 'none'` 的 continue 提前放行，存在性检查根本走不到（实测：删
    // `Typing/ue/index.d.ts` 后仍 exit 0）。逐源遍历把这一类永久关掉：表里**新增**的源
    // 自动进入判据，无需有人记得加用例。
    for (const s of SOURCES) {
      const dir = sandbox(); run(dir, '--all');
      const gone = join(dir, s.path);
      const verifyOnly = () => spawnSync(process.execPath, [CLI, '--project', dir, '--verify-only'], { encoding: 'utf8' });

      // 先钉住基线是绿的：否则下面的"变红"可能由别的既有违例满足，这条就失去甄别力
      const before = verifyOnly();
      assert.equal(before.status, 0, `${s.id}: 基线必须绿 —— ${before.stderr}`);

      unlinkSync(gone);
      assert.ok(!existsSync(gone), `${s.id}: 删除必须真的生效，否则这条是空测`);

      const r = verifyOnly();
      assert.notEqual(r.status, 0, `${s.id}: 源文件缺失后 --verify-only 必须非 0 退出（stdout=${r.stdout}）`);
      // 只断言**该违例专属**的信息：失败必须**指名**缺的是哪个源、哪条路径。
      // 断言退出码非 0 是不够的 —— 同一棵树往往还触发别的检查（非切分源的 manifest 行
      // 会另外报"指向不存在的文件"），退出码会被它们满足，这条就失去甄别力。
      const line = `${s.id}: 源文件不存在: ${s.path}`;
      assert.ok(r.stderr.includes(line), `${s.id}: 失败必须指名缺源 —— 期待含 ${JSON.stringify(line)}，实得:\n${r.stderr}`);
      // 恰好一条：既然检查已无条件（含 parser:'none'），就必须确认它既不重复报告、
      // 也不把这条失败扩散成下游的符号/行数断言（这些源本来就没有符号行）
      const hits = r.stderr.split('\n').filter((l) => l.includes(line));
      assert.equal(hits.length, 1, `${s.id}: 缺源失败必须恰好一条，实得 ${hits.length} 条`);
      assert.doesNotMatch(r.stdout, /自检通过/, `${s.id}: 缺源时不得打印自检通过`);
    }
  });
});

// 注意标题的范围限定：**只有可达的检查**能被本组的端到端用例钉住接线。
// checkUnitsNonEmpty / checkMarkerPairs 在 runChecks 内**不可达**（解析器先抛错），
// 其接线无法被任何端到端断言证明 —— 见文末「判据本身」直接单测与 verify.mjs 的注释。
// 原标题写「摘掉任意一条检查都必须变红」，对这两条是**字面为假**的。
describe('§7 检查接线：摘掉任一条**可达**检查都必须让 --verify-only 变红', () => {
  // 这一组守的是一个**沉默**的失效面：`runChecks` 里那几次调用，摘掉任何一次，
  // 其余用例**全绿**（实测：删掉 checkFragmentLength / checkPackageNotSplit /
  // checkMarkerPairs / checkManifestConsistency 的调用，或把 checkUniqueFragNames
  // 传成空数组，套件均 102/102 通过）。于是"接线"本身没有守卫 —— 一次重构就能把
  // 这些检查悄悄摘掉，而 Task 10/12 的验收正是靠它们。
  // 下面每条植入一种**只有该项会报**的违例，并只断言**该违例专属的信息**：
  // 只断言"退出码非 0"是不够的 —— 同一次篡改往往同时触发别的检查，退出码会被它们满足。
  const manifestPath = (dir) => join(fragDir(dir), 'manifest.jsonl');
  const rowsOf = (dir) => manifestText(dir).trimEnd().split('\n');
  const writeRows = (dir, rows) => wf(manifestPath(dir), rows.join('\n') + '\n');
  const verifyOnly = (dir) =>
    spawnSync(process.execPath, [CLI, '--project', dir, '--verify-only'], { encoding: 'utf8' });
  const metaOf = (dir) => JSON.parse(rowsOf(dir)[0]);
  const setMeta = (dir, mut) => { const rows = rowsOf(dir); const m = metaOf(dir); mut(m); rows[0] = JSON.stringify(m); writeRows(dir, rows); };

  test('★非相邻的 (frag,line) 重复 → 「(frag,line) 重复」（并钉住 groupByFrag 的组内排序）', () => {
    const dir = sandbox(); run(dir, '--all');
    const rows = rowsOf(dir);
    const dupAt = rows.findIndex((l, k) => k > 0 && JSON.parse(l).src === 'ue');
    const dup = JSON.parse(rows[dupAt]);
    // 在**同一个源内**另取一个**别的分片**的行 —— 跨源改 frag 会额外触发"分片名重复"，
    // 那样这条就不再是只甄别"重复"了。
    const victimAt = rows.map((l, k) => [k, l])
      .filter(([k, l]) => k > 0 && l && JSON.parse(l).src === 'ue' && JSON.parse(l).frag !== dup.frag)
      .pop()[0];
    assert.ok(victimAt - dupAt > 1, `两条必须不相邻（相距 ${victimAt - dupAt}）—— 相邻重复在被移除排序后仍会被发现，这条就失去甄别力`);
    const victim = JSON.parse(rows[victimAt]);
    victim.frag = dup.frag; victim.line = dup.line;
    rows[victimAt] = JSON.stringify(victim);
    writeRows(dir, rows);
    const r = verifyOnly(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\(frag,line\) 重复/);
  });

  test('★跨源重名分片 → 「分片名重复」', () => {
    const dir = sandbox(); run(dir, '--all');
    const rows = rowsOf(dir);
    const ueFrag = JSON.parse(rows.find((l, k) => k > 0 && JSON.parse(l).src === 'ue')).frag;
    const bpAt = rows.findIndex((l, k) => k > 0 && JSON.parse(l).src === 'bp');
    assert.ok(bpAt > 0, 'fixture 应含 bp 行');
    const rb = JSON.parse(rows[bpAt]);
    assert.notEqual(rb.frag, ueFrag, '前提：两源分片名本来就不同');
    rb.frag = ueFrag;
    rows[bpAt] = JSON.stringify(rb);
    writeRows(dir, rows);
    const r = verifyOnly(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /分片名重复/);
  });

  test('★小 package 跨分片 → 「package 跨分片」', () => {
    const dir = sandbox(); run(dir, '--all');
    const rows = rowsOf(dir);
    const bp = rows.map((l, k) => [k, l]).filter(([k, l]) => k > 0 && JSON.parse(l).src === 'bp');
    const [srcAt] = bp[0];
    const src = JSON.parse(rows[srcAt]);
    const other = [...new Set(bp.map(([, l]) => JSON.parse(l).frag))].find((f) => f !== src.frag);
    assert.ok(other, 'fixture 的 bp 应切成至少两片，否则这条构造不出来');
    // 把该行**复制**到另一个 bp 分片：包的总行数没变、仍 <= 阈值，却横跨两片 ——
    // 正是 §4.3 的硬约束被破坏，且因为总量 <= 阈值而**不能**走例外豁免。
    rows.push(JSON.stringify({ ...src, frag: other }));
    writeRows(dir, rows);
    const r = verifyOnly(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /package 跨分片/);
  });

  test('★分片按阈值切好后，manifest 里的阈值被改小 → 「片长超阈值」', () => {
    const dir = sandbox(); run(dir, '--all');
    const th = metaOf(dir).threshold;
    setMeta(dir, (m) => { m.threshold = 1; });
    const r = verifyOnly(dir);
    assert.notEqual(r.status, 0);
    // 断言里带上被改小的阈值，顺带证明校验读的是 **manifest 记的那个数**而不是常量
    assert.match(r.stderr, new RegExp(`片长超阈值 1:`));
    assert.notEqual(th, 1, '前提：原阈值不是 1，且分片确按原阈值切出');
  });

  test('★manifest 未记录 threshold → 如实报失败并给出补救', () => {
    const dir = sandbox(); run(dir, '--all');
    setMeta(dir, (m) => { delete m.threshold; });
    const r = verifyOnly(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /未记录 threshold/);
    assert.match(r.stderr, /--all/, '必须告诉用户怎么补救');
  });

  test('checkUnitsNonEmpty / checkMarkerPairs 判据本身（直接单测 —— 二者的**接线**在 runChecks 里不可达）', () => {
    // 这两条**故意**不走端到端，因为端到端**不可能**有甄别力：
    //   · 0 个单元  → `parseDeclarations` 自己就抛错（parse.mjs:76）
    //   · 标记对数 != 单元数 → `parseBp` 自己就抛错（parse.mjs:153-155）
    // runChecks 捕获解析异常后 `continue` 掉该源，**根本走不到**这两个检查 ⇒
    // 它们在 runChecks 里永远不会触发，任一端到端断言都会被**解析器的**报错满足
    // （我第一版就写成那样：删掉 checkMarkerPairs 的调用，用例照样全绿 —— 典型的假绿）。
    // 所以这里只证明**判据本体**正确；"那次调用还在"**无法**被测试证明，
    // 只能靠评审读代码。已在 verify.mjs 的注释里写明这一点。
    assert.equal(checkUnitsNonEmpty('ue', [{ name: 'A', lines: 3, text: 'x' }]).ok, true);
    const noUnits = checkUnitsNonEmpty('ue', []);
    assert.equal(noUnits.ok, false);
    assert.match(noUnits.detail, /0 个单元/);

    assert.equal(checkMarkerPairs('bp', 3, 3).ok, true);
    const mismatch = checkMarkerPairs('bp', 2, 3);
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.detail, /标记对数 2 != 单元数 3/);
  });
});

/**
 * ORPHAN_PREFIX 是一张**归属表**，被两处读：`cleanOrphans`（emit.mjs）据此判定"这片属于本目标吗"，
 * `checkUniqueFragNames`（verify.mjs）据此判定"这片恰好归属 1 个源吗"。表里少写一种命名形态，
 * 两个后果都**不报错就发生**：陈旧的例外片永不删除；随后 `--verify-only` 报它"前缀归属 0 个源"
 * —— 报错把真因（表不全）说成了"这片没有归属"，排障者会去修那片而不是补这张表。
 * 所以这里把"表覆盖了打包器可能产出的每一个片名"变成一条可断言的事实，
 * 而不是靠人眼比对 pack.mjs 的命名分支与 emit.mjs 的表。
 *
 * 为什么不用 CLI 跑一遍收片名：CLI 只有一个**全局**阈值，而 fixture 里 bp / decorators 的
 * 单元行数全部相等 —— 任何单一阈值要么全走常规分支、要么全走例外分支，取不到"两种形态都在"。
 * 故改为直接对每个源的 fixture 单元跑 pack()，取两个阈值：
 *   · `Number(TH)`（集成测试用的那个阈值）—— 出常规片；
 *   · 严格小于最短单元行数的阈值 —— 每个单元都超阈值，必走例外分支，出例外片。
 * 两者并集就是"该源可能产出的片名"在本 fixture 下的代表。
 */
describe('emit: ORPHAN_PREFIX 覆盖各切片源可能产出的全部分片名', () => {
  for (const s of SOURCES.filter((x) => x.sliced)) {
    test(`源 ${s.id}：常规片与例外片的片名都落在 ORPHAN_PREFIX.${s.id} 内`, () => {
      const { units } = parseSource(s.id, rf(join(PROJECT, s.path), 'utf8'));
      const shortest = Math.min(...units.map((u) => u.lines));
      const namesAt = (threshold) => pack(units, { threshold, id: s.id }).map((f) => f.name);

      const regular = namesAt(Number(TH));
      // 阈值下限取 1：0 会让 chunkBounds 的步长为 0（死循环）。纯防御，fixture 的最短单元远大于它。
      const exceptional = namesAt(Math.max(1, shortest - 1));
      assert.notDeepEqual(exceptional, regular,
        '前提：两个阈值必须切出不同的片名集合');

      // **两种命名形态必须都真的出现**。只断言"两个集合不同"是不够的：集合不同也可能
      // 两套全是同一形态（例如全落在常规分支），于是 ORPHAN_PREFIX 的另一项**永不被覆盖**
      // 而本用例照样绿 —— 正是"守卫比它自己的注释弱"那一类缺陷。
      // 判据由**单元自身**导出，不写死任何具体片名，故 fixture 增删后仍然成立：
      //   · 常规片：`<id>.<NNN>` / `bp-<root>-<NNN>` —— 词干**不含**单元派生串；
      //   · 例外片：`<id>-<单元名>-<NNN>`（bp 用 package 全路径）—— 词干由单元派生（pack.mjs 的两条命名分支）。
      const sanitize = (t) => String(t).replace(/\./g, '-');   // 与 pack.mjs 的 sanitize 同规则
      const stems = new Set(units.map((u) => `${s.id}-${sanitize(s.id === 'bp' ? u.pkg : u.name)}`));
      const isExceptionalName = (n) => [...stems].some((st) => n.startsWith(`${st}-`));
      assert.ok(regular.some((n) => !isExceptionalName(n)),
        `前提：TH=${Number(TH)} 下必须出现**常规形态**片名，否则该形态没被覆盖，本用例退化成空测（实得 ${JSON.stringify(regular)}）`);
      assert.ok(exceptional.some(isExceptionalName),
        `前提：阈值 ${Math.max(1, shortest - 1)}（最短单元 ${shortest} 行 - 1）下必须出现**例外形态**片名，否则该形态没被覆盖（实得 ${JSON.stringify(exceptional)}）`);

      for (const name of new Set([...regular, ...exceptional])) {
        const prefixes = ORPHAN_PREFIX[s.id] ?? [];
        assert.ok(prefixes.some((p) => name.startsWith(p)),
          `源 ${s.id} 会产出 ${name}，但 ORPHAN_PREFIX.${s.id} = ${JSON.stringify(ORPHAN_PREFIX[s.id])} 不覆盖它`);
      }
    });
  }
});

/**
 * spec §5.5 的「三个源的归属前缀集合两两互不重叠……"属于 T"良定义」此前**没有断言**
 * —— 它只以注释形式散落在 emit.mjs / pack.mjs / verify.mjs 与 regenerate.md 的散文里。
 * 而它是一条**被依赖的前提**：`cleanOrphans` 靠它做"只删本目标的分片"，
 * `checkUniqueFragNames` 靠它做"这片恰好归属 1 个源"。
 * 表里新增一项若与别源重叠，两个后果都**不报错就发生**：别源的分片被当孤儿删掉；
 * 归属判定算出 2 个源（报错还会把真因说成"这片没有归属"）。
 * 故把这条不变量**钉在表上**（而不是钉在产出的片名上）：判据是纯关系式（互为前缀），
 * 对将来新增的源条目/前缀同样生效，且不含任何规模常量。
 */
describe('emit: ORPHAN_PREFIX 的前缀两两互不重叠（跨源）', () => {
  test('真实表满足不变量；判据本身不是空测', () => {
    assert.doesNotThrow(() => assertPrefixesDisjoint(ORPHAN_PREFIX));
    // 前提：至少两个源、每个源至少一个前缀 —— 否则"两两互不为前缀"没有对可比，本用例退化成空测
    const ids = Object.keys(ORPHAN_PREFIX);
    assert.ok(ids.length >= 2, `至少要有两个源才有"跨源"可比，实得 ${ids.length}`);
    for (const id of ids) assert.ok(ORPHAN_PREFIX[id].length >= 1, `源 ${id} 的前缀集合为空`);
  });

  test('★重叠必须响亮失败（判据本体的直接单测 —— 真实表满足它，故只能喂合成表）', () => {
    // 给 ue 加一个短前缀 'b'：它是 bp 的 'bp-' 的前缀 ⇒ 以 'b' 开头的分片会**同时**归属两源
    assert.throws(() => assertPrefixesDisjoint({ ue: ['ue.', 'b'], bp: ['bp-'] }), /互为前缀/);
    // 反方向（较长者在前）同样必须被抓
    assert.throws(() => assertPrefixesDisjoint({ ue: ['ue-'], bp: ['ue-x'] }), /互为前缀/);
    // 同源内部允许包含关系（不得误伤）：两个 ue 前缀互为前缀也不算违规
    assert.doesNotThrow(() => assertPrefixesDisjoint({ ue: ['ue-', 'ue-x'], bp: ['bp-'] }));
  });
});
