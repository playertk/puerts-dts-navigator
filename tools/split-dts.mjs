#!/usr/bin/env node
// Puerts .d.ts 分片工具。零依赖，Node >= 22.18（`import.meta.main` 的下限，见 Global Constraints）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { SOURCES, parseSource } from './lib/parse.mjs';
import { pack } from './lib/pack.mjs';
import { layoutFragment, cleanOrphans, FRAGMENTS_DIR } from './lib/emit.mjs';
import { buildMeta, buildRows, serialize, parseManifest, planRun, mergeRows, mergeMeta } from './lib/manifest.mjs';
import { runChecks } from './lib/verify.mjs';

/** 默认片长阈值（spec §4.3）。**唯一出现处** —— 其余位置一律经参数传递。 */
export const DEFAULT_THRESHOLD = 1800;

export const USAGE = `用法: node split-dts.mjs [选项]

  --target <ids>   只处理列出的源（逗号分隔）: ${SOURCES.map((s) => s.id).join(',')}
  --all            全量重建（等价于 --target <全部> --force）
  --force          与 --target 组合，忽略哈希强制重切
  --project <path> 项目根（默认向上查找含 tsconfig.json 的最近目录）
  --threshold <n>  片长阈值（默认 ${DEFAULT_THRESHOLD}）；改阈值即改变分片，故等价于强制全量
  --verify-only    不切分，只对现有产物跑自检
  --no-verify      切分后跳过自检（仅供排障）
  --help           显示本帮助

退出码: 0 = 成功（含"未变、已跳过"）；非 0 = 失败，且不留半更新的 manifest`;

export function parseArgs(argv) {
  const a = { targets: null, all: false, force: false, project: null, threshold: null, verifyOnly: false, noVerify: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--all') a.all = true;
    else if (t === '--force') a.force = true;
    else if (t === '--verify-only') a.verifyOnly = true;
    else if (t === '--no-verify') a.noVerify = true;
    else if (t === '--target') a.targets = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (t === '--project') a.project = argv[++i];
    else if (t === '--threshold') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--threshold 需要正整数，收到 ${JSON.stringify(argv[i])}`);
      a.threshold = n;
    }
    else throw new Error(`未知参数: ${t}\n\n${USAGE}`);
  }
  if (a.targets) {
    // 空列表必须**响亮失败** —— 这是下面那条白名单**同一个洞的另一半**：
    // `--target ""` / `--target ,` / 裸 `--target`（缺值）都得到 `[]`，而 `[]` 在 JS 里是**真值**
    // ⇒ 下面的白名单 for 跑 0 次、planRun 收到空 pool ⇒ stale 为空 ⇒ 走"所有源均为最新"
    // 提前返回并**退出 0**。在已有 manifest 的真实项目上，这会把"我改了源、让脚本重切"
    // **静默**变成"什么都没做，且报告一切正常"（已实测复现：改动 ue.d.ts 后跑 `--target ""`，
    // 输出 "unchanged — skipped" 且 EXIT=0）。这正是本计划要根除的静默成功面。
    if (!a.targets.length) {
      throw new Error(`--target 需要至少一个源 id（收到空值；可选: ${SOURCES.map((s) => s.id).join(',')}）`);
    }
    const known = new Set(SOURCES.map((s) => s.id));
    for (const id of a.targets) if (!known.has(id)) throw new Error(`未知源 id: ${id}（可选: ${[...known].join(',')}）`);
  }
  return a;
}

/**
 * 向上查找含 tsconfig.json 的最近目录（最多 4 层）。
 * **不可写死为 `..`**：脚本在技能内是 <SKILL>/tools/split-dts.mjs，
 * 装到项目里是 <project>/Tools/split-dts/split-dts.mjs —— 相对层级不同（spec §5.5）。
 * 失败时**列出尝试过的候选目录**（spec §5.5「查不到则响亮失败并列出尝试过的候选」）：
 * 只报起始目录的话，调用方得回读源码才能知道搜索规则覆盖了哪些目录。
 */
export function findProjectRoot(startDir) {
  let dir = resolve(startDir);
  const tried = [];
  for (let i = 0; i < 4; i++) {
    tried.push(dir);
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;                 // 已到盘根，提前收工（try 列表比 4 项短）
    dir = up;
  }
  throw new Error(`未能在 ${startDir} 的上 4 层内找到 tsconfig.json`
    + `（已尝试: ${tried.join('、')}），请用 --project 显式指定项目根`);
}

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

function readSource(root, src) {
  const abs = join(root, src.path);
  if (!existsSync(abs)) throw new Error(`源文件不存在: ${src.path}（项目根 ${root}）`);
  const buf = readFileSync(abs);
  const st = statSync(abs);
  return { buf, text: buf.toString('utf8'), sha1: sha1(buf), size: buf.length, mtime: st.mtime.toISOString() };
}

/** 计算阶段：**只读盘、不写盘**。任何抛错都不会留下改动。 */
export function planRunToDisk({ root, threshold, targets, force }) {
  const manifestPath = join(root, FRAGMENTS_DIR, 'manifest.jsonl');
  const prev = existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, 'utf8'))
    : { meta: null, rows: [], corrupt: true };

  const loaded = SOURCES.map((src) => {
    const r = readSource(root, src);
    return { ...src, ...r };
  });

  const targetsArg = targets;
  const decision = planRun({
    prev,
    sources: loaded.map(({ id, path, sha1, size, mtime }) => ({ id, path, sha1, size, mtime })),
    threshold,
    targets: targetsArg,
    force,
  });

  const staleSet = new Set(decision.stale);
  const toProcess = loaded.filter((s) => staleSet.has(s.id));
  const skipped = loaded.filter((s) => !staleSet.has(s.id)).map((s) => s.id);

  const newFrags = new Map();       // id -> Fragment[]
  const newRows = new Map();        // id -> rows
  const keepNames = new Map();      // id -> Set<string>

  for (const s of toProcess) {
    const { units, markerPairs } = parseSource(s.id, s.text);

    // ⚠️ **下面两个 throw 在当前实现下不可达**（防御纵深，不是可测的判据）：
    // `parseDeclarations` 对 0 单元**自己就抛错**，`parseBp` 对 0 单元与
    // `markerPairs !== units.length` 也自己抛错（parse.mjs）⇒ `parseSource` 不可能返回
    // 这两种值。保留它们的理由是让"判据层"独立表达 §4.3 的硬约束（边界规则套错时的后果
    // 不是报错而是**静默切出 0 个单元**），将来若有调用方绕过解析器的抛错，这里仍会拦住。
    // **任何端到端测试都无法证明这几行还在** —— 删掉它们，用解析器报错做的断言照样全绿
    // （同 verify.mjs 的 checkUnitsNonEmpty / checkMarkerPairs，那两处写明了同一结论）。
    if (s.sliced && units.length === 0) {
      // §4.3 的硬断言：边界规则用错时的后果不是报错而是静默切出 0 个单元
      throw new Error(`${s.id}: 识别到 0 个单元 —— 边界规则与该文件形态不匹配，拒绝产出空分片`);
    }
    if (s.parser === 'markers' && markerPairs !== units.length) {
      throw new Error(`${s.id}: 标记对数 ${markerPairs} != 单元数 ${units.length}`);
    }

    if (!s.sliced) {
      // 未切分文件：frag 直接指向原文件，line 是原文件行号（spec §5.3）
      newRows.set(s.id, buildRows(s.id, units.map((u) => ({
        unit: u, frag: s.path, line: u.startLine, sliced: false,
      }))));
      continue;
    }
    const frags = pack(units, { threshold, id: s.id });
    const layouts = frags.map(layoutFragment);
    newFrags.set(s.id, layouts);
    newRows.set(s.id, buildRows(s.id, layouts.flatMap((l) => l.placements)));
    keepNames.set(s.id, new Set(layouts.map((l) => l.name)));
  }

  const meta = mergeMeta(
    prev.meta ?? { sources: [] },
    loaded.map(({ id, path, sha1, size, mtime }) => ({ id, path, sha1, size, mtime })),
    staleSet, threshold, new Date().toISOString(),
  );
  const rows = prev.corrupt || decision.mode === 'all'
    ? [...newRows.values()].flat()
    : mergeRows(prev.rows, staleSet, newRows, loaded.map((s) => s.id));

  return { root, decision, skipped, newFrags, keepNames, rows, meta, threshold };
}

/**
 * 原子写：先写同目录临时文件，再 `rename` 覆盖。**这不是洁癖** —— 它是 spec §5.5 静默失败面的
 * 最后一环：`parseManifest` 只在**行中**截断时抛 `JSON.parse`；**恰在行边界**截断时它返回
 * `corrupt:false` 且 `rows` 少若干条，而第 1 行的 meta 完好 ⇒ `planRun` 比 sha1 全部匹配、
 * `stale` 为空 ⇒ 把这份**已被截断的行集原样写回**：索引永久性少行且**不报任何错**，
 * Agent 之后再也查不到这些符号。`rename` 在 POSIX 与 Windows 上均原子（覆盖已存在文件亦然），
 * 故不存在"写到一半"的中间态。临时文件用固定后缀：同一目录、单进程、无并发。
 */
function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/**
 * 落盘阶段：**所有写盘都在这里**，且按"先分片、后 manifest"的顺序。
 * 计算阶段任何抛错都不会走到这里 => 半更新不留存（spec §7）。
 * （本块原先挂错了位置 —— 落在 `writeAtomic` 头上，见 Task 7 评审。）
 */
export function applyPlan(plan) {
  const dir = join(plan.root, FRAGMENTS_DIR);
  mkdirSync(dir, { recursive: true });

  const written = [];
  for (const [id, layouts] of plan.newFrags) {
    for (const l of layouts) {
      writeAtomic(join(dir, l.name), l.text);
      written.push(l.name);
    }
    const deleted = cleanOrphans(dir, id, plan.keepNames.get(id));
    if (deleted.length) process.stderr.write(`${id}: 清理孤儿分片 ${deleted.length} 个\n`);
  }

  writeAtomic(join(dir, 'manifest.jsonl'), serialize(plan.meta, plan.rows));
  return written;
}

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  if (args.help) { process.stdout.write(`${USAGE}\n`); return 0; }

  try {
    const root = args.project ? resolve(args.project) : findProjectRoot(import.meta.dirname);
    if (!existsSync(root)) throw new Error(`项目根不存在: ${root}`);

    const threshold = args.threshold ?? DEFAULT_THRESHOLD;

    // --verify-only 不传 threshold：自检用 manifest 里记录的阈值（分片就是按它切的），
    // 传一个与切分时不同的阈值只会产生假失败
    if (args.verifyOnly) return runChecks({ root }) ? 0 : 1;

    const plan = planRunToDisk({
      root, threshold,
      targets: args.all ? null : args.targets,
      force: args.all || args.force,
    });

    if (!plan.decision.stale.length) {
      // 全部源均为最新：跳过写盘。
      // ⚠️ 措辞纠正（Task 7 评审）：**不能说"manifest 内容不会变"** —— 行确实与 prev 相同，
      // 但 `mergeMeta` 会盖一个新的 `generated`（manifest.mjs 写 `now`），真写下去文件内容**会**变。
      // 省掉写盘的真实理由只是"没有任何源需要处理、行没变，写它没有意义"，**不是"内容相同"**。
      // 本任务有两条用例在断言 manifest 的逐字节/逐字段相同，错误措辞会把人引向错误的判据
      // —— 这正是 Task 7 两次 BLOCKED 的同一个坑。
      process.stdout.write(`所有源均为最新（${plan.skipped.join(', ')}）—— unchanged — skipped\n`);
      return 0;
    }

    const written = applyPlan(plan);
    process.stdout.write(`已写出 ${written.length} 个分片；本次处理: ${plan.decision.stale.join(', ')}\n`);

    if (!args.noVerify && !runChecks({ root })) return 1;
    return 0;
  } catch (e) {
    process.stderr.write(`失败: ${e.message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
