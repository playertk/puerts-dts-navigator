// §7 自检。零依赖。全部检查返回 { ok: boolean, detail: string }。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SOURCES, parseSource } from './parse.mjs';
import { ORPHAN_PREFIX, FRAGMENTS_DIR } from './emit.mjs';
import { parseManifest } from './manifest.mjs';
import { expandUnits } from './pack.mjs';

const ok = (detail = '') => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

/**
 * 完整性：sha1(单元文本 -> 排序 -> 拼接) 两侧相等。
 * 分片**重排**了单元，故无法用行号回验，只能做内容级校验。
 * ⚠️ 覆盖范围仅**单元文本**：preamble（两文件共有的 8 行）与 trailer（`}` 等）
 * 由解析层**有意丢弃**（见 parse.mjs 的 trimTrailer 注释），不在断言范围内 ——
 * 本检查不宣称整文件逐字节可还原（spec §7）。
 */
export function checkContentIntegrity(units, fragmentsUnits) {
  const h = (list) => createHash('sha1')
    .update(list.map((u) => u.text).sort().join('\x00')).digest('hex');
  const a = h(units), b = h(fragmentsUnits);
  if (a !== b) return fail(`完整性失败: 源单元数 ${units.length} / 分片单元数 ${fragmentsUnits.length}，sha1 ${a} != ${b}`);
  return ok(`完整性通过（${units.length} 个单元）`);
}

/**
 * 片长 <= threshold。**例外片豁免**：单单元自身超阈值时，pack 只能把它单独成片
 * （spec §4.3 的例外分支）—— 不豁免就会把正常产出判为失败。
 *
 * ⚠️ 量的是**单元行数合计**，**不是分片文件的物理行数**：片头（`// <片名> — N unit(s)`
 * 一行 + 每个单元一行清单 + 一个空行，见 emit.mjs 的 layoutFragment）不计入，
 * 于是物理行数 = 本判定值 + 单元数 + 2。**不要**拿 `wc -l` 的结果去推断本检查红不红 ——
 * 实测两者经常分居阈值的两侧。
 */
export function checkFragmentLength(frags, threshold) {
  const bad = frags.filter((f) => f.units.length > 1
    && f.units.reduce((n, u) => n + u.lines, 0) > threshold);
  if (bad.length) return fail(`片长超阈值 ${threshold}: ${bad.map((f) => f.name).join(', ')}`);
  return ok();
}

/** .fragments/ 内不得出现 .ts / .d.ts —— typeRoots 会自动加载，与原文件 duplicate identifier（spec §2.2） */
export function checkCompileIsolation(dir) {
  if (!existsSync(dir)) return ok();
  const bad = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  if (bad.length) return fail(`.fragments/ 内出现编译产物: ${bad.join(', ')} （会污染 tsc）`);
  return ok();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 每个 (frag,line) 唯一，且该位置**起至下一个符号之间**能找到同名声明。
 *
 * 为何是"窗口"而不是"单行"：bp 单元的首行是 `// __TYPE_DECL_START: …` 标记，
 * 本身不含类型名，只有往下才是 `namespace` / `class`。按单行严格比对会把所有 bp 行判失败。
 * name 本身不唯一（同名重载），故以 (frag,line) 为键。
 *
 * 为何还要把"**被切成多片的符号**"单独拎出来：ue 的**单元级**例外分支（spec §4.3）
 * 会把单个超阈值单元拆进多个分片，**续片的正文里不重复类型名**（名字只在片头注释里，
 * 见 emit.mjs `layoutFragment`）⇒ 行号窗口对续片**恒不命中**。这类行改按**片头注释**
 * 校验；其余行仍按窗口校验。**不是为了兼容理论边界**：真实 ue.d.ts 实测恰有 1 个单元
 * 超阈值（KismetMathLibrary），而 split-dts.mjs 每次落盘后都跑 runChecks
 * ⇒ 不区分就会让整个 CLI 在**合法产出**上恒退出 1。
 */
export function checkManifestConsistency(root, rows) {
  const dir = join(root, FRAGMENTS_DIR);
  const cache = new Map();
  const linesOf = (abs) => {
    if (!cache.has(abs)) cache.set(abs, readFileSync(abs, 'utf8').split(/(?<=\n)/));
    return cache.get(abs);
  };

  // 键取 (src,kind,pkg,name) 而**不是** name：name 本身不唯一（spec §2.4/§5.2 实测
  // `type BuiltinBool` 与 `const BuiltinBool` 同名共存），只按 name 计数会把两个无关的
  // 单行符号误判成"被切片"。出现在多于一个分片里的符号 = 被单元级例外切开的符号。
  const keyOf = (r) => `${r.src}\x00${r.kind}\x00${r.pkg ?? ''}\x00${r.name}`;
  // 收集的是**分片名集合**，不是行数 —— 这个区别是实质的，不是措辞：
  // 同名行数 > 1 还有第二种成因：**同一文件里的重载**（实测真实 `Typing/puerts/index.d.ts`
  // 的 `toDelegate` 在第 74、76 行各一行，同一分片）。按行数判定会把重载误判成"被切片"，
  // 转而要求片头注释 `// function <name>`，而该形态的分片（sliced:false 时"分片"就是源文件本身）
  // **根本没有片头注释** ⇒ 合法产出被判失败。按分片集合判定则重载落回常规窗口校验，
  // 而窗口本来就能覆盖重载（每个重载行到自己下一个符号之间必含自己的名字）。
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(keyOf(r))) seen.set(keyOf(r), new Set());
    seen.get(keyOf(r)).add(r.frag);
  }
  const chunked = (r) => seen.get(keyOf(r)).size > 1;

  for (const [frag, group] of groupByFrag(rows)) {
    const abs = group[0].sliced ? join(dir, frag) : join(root, frag);
    if (!existsSync(abs)) return fail(`manifest 指向不存在的文件: ${frag}`);
    const lines = linesOf(abs);

    // (frag,line) 唯一性必须**先整体扫一遍**，不能留在这个循环里：相邻两行行号相同时，
    // 先到的那一轮算出的窗口是 slice(L-1, L-1) = 空串，正则必然不命中 ⇒ 会在到达重复判据
    // 之前就带"找不到 name"返回 ⇒ 那条判据**永远不可达**，且报错指错方向（把"重复"报成"找不到"）。
    for (let i = 1; i < group.length; i++) {
      if (group[i - 1].line === group[i].line) {
        return fail(`manifest 中 (frag,line) 重复: ${frag}:${group[i].line}`);
      }
    }
    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const from = r.line - 1;
      if (from < 0 || from >= lines.length) return fail(`行号越界: ${frag}:${r.line}`);
      if (chunked(r)) {
        // 续片以片头注释自我标识 —— `// <kind> <name>` 必须整行存在（layoutFragment 的契约）。
        // **不放松成"名字在片内任意位置出现"**：那样连常规行也会因为片头注释里有名字而通过，
        // 行号约束就被整体作废了；这里只对"被切片"的行换判据，常规行的窗口校验原样保留。
        if (!new RegExp(`^// ${escapeRe(r.kind)} ${escapeRe(r.name)}$`, 'm').test(lines.join(''))) {
          return fail(`(${frag},${r.line}) 被切片的符号在片头注释中找不到 // ${r.kind} ${r.name}`);
        }
        continue;
      }
      const to = i + 1 < group.length ? group[i + 1].line - 1 : lines.length;
      const window = lines.slice(from, to).join('');
      // 用**标识符字符类**界定边界，不用 `\b`：`\b` 只认 `\w`（= `[A-Za-z0-9_]`），
      // 而 TS 标识符还允许 `$`（spec §2.4 实测 `interface $CallbackID {}`）。
      // `\b$CallbackID\b` 要求 `$` 之前有词边界，但 `$` 与它前面的空格**都不是 \w**
      // ⇒ 词边界不存在 ⇒ **恒不命中** ⇒ 真实 `puerts.d.ts` / `puerts/index.d.ts` 的
      // 10 个 `$` 开头符号全部被判失败。前后否定环视把 `$` 一并算作标识符字符，
      // 既修好该形态，又保住"不得匹配更长的标识符"（`$Ref` 不得因 `$Reference` 通过）。
      if (!new RegExp(`(?<![\\w$])${escapeRe(r.name)}(?![\\w$])`).test(window)) {
        return fail(`(${frag},${r.line}) 起至下一符号之间找不到 name=${r.name}`);
      }
    }
  }
  return ok(`${rows.length} 行全部自洽`);
}

/**
 * §4.3 硬断言：边界规则套错时后果是**静默切出 0 个单元**，不报错。
 *
 * ⚠️ **本次调用在 runChecks 内不可达**：0 单元时 `parseDeclarations` **自己就抛错**
 * （parse.mjs「4 空格声明族：识别到 0 个单元。…拒绝静默返回空结果」），runChecks 捕获后
 * `continue` 掉该源，走不到这里。保留它是为了"判据层"仍能独立表达这条硬约束
 * （也可能被将来的非 runChecks 调用方复用），但**任何端到端测试都无法证明"这次调用还在"**——
 * 删掉那次调用，用解析器的报错去断言「0 个单元」的用例照样全绿（实测如此）。
 * 因此它只有直接单测，接线由代码评审看守。**不要**为了"让它可测"去改解析器的抛错行为：
 * 解析器抛错是 spec §4.3 要求的。
 */
export function checkUnitsNonEmpty(id, units) {
  if (units.length === 0) return fail(`${id}: 识别到 0 个单元 —— 边界规则与文件形态不匹配`);
  return ok(`${id}: ${units.length} 个单元`);
}

/**
 * bp 专属：标记对数必须等于单元数（一块恰一类型）。
 *
 * ⚠️ 同 `checkUnitsNonEmpty`：**在 runChecks 内不可达**。`parseBp` 自己就抛错
 * （parse.mjs「bp: 标记对数 N != 单元数 M」），runChecks 捕获后 `continue`。
 * 端到端断言「未闭合」只会命中**解析器的**报错，与这次调用是否还在无关（实测：
 * 删掉调用，标记类用例仍全绿 —— 这正是评审发现的第一版假绿）。故只有直接单测。
 */
export function checkMarkerPairs(id, markerPairs, unitCount) {
  if (markerPairs !== unitCount) return fail(`${id}: 标记对数 ${markerPairs} != 单元数 ${unitCount}`);
  return ok();
}

/**
 * 分片名**唯一**且**归属明确**。两者都是"不报错的错"：
 *  - 唯一：同名两片互相覆盖，直接丢数据（常规名 `bp-A-B-001` 与例外名 root=A/pkg=B 会退化同串）。
 *  - 归属：cleanOrphans 靠 ORPHAN_PREFIX 判断"这片属于谁"。若某源产出了别源前缀下的名字，
 *    别源下次 `--target` 就会把它当孤儿删掉（§5.5）—— 前缀互不重叠是那条推理的前提。
 */
export function checkUniqueFragNames(frags) {
  const seen = new Map();
  for (const f of frags) {
    if (seen.has(f.name)) return fail(`分片名重复，会互相覆盖: ${f.name}（源 ${seen.get(f.name)} 与 ${f.src}）`);
    seen.set(f.name, f.src);

    const owners = Object.entries(ORPHAN_PREFIX)
      .filter(([, ps]) => ps.some((p) => f.name.startsWith(p))).map(([id]) => id);
    if (owners.length !== 1) return fail(`分片名 ${f.name} 的前缀归属 ${owners.length} 个源（应恰好 1 个）`);
    if (owners[0] !== f.src) {
      return fail(`分片 ${f.name} 属于源 ${f.src}，但前缀归属 ${owners[0]} —— 对方 --target 时会把它当孤儿删掉`);
    }
  }
  return ok(`${frags.length} 个分片名唯一且归属明确`);
}

/**
 * package 不跨片（bp 硬约束）。**判定口径**：单元行数合计 <= threshold 的 package
 * 必须只出现在**一个**分片里；合计 > threshold 者走 §4.3 的例外分支，**豁免**
 * （spec §7 该行自带"（例外分支除外）"—— 与"单元不跨片"在例外分支上的豁免同源）。
 *
 * 为何用"总量 <= threshold"而**不是**"靠名字认出例外片"：例外片名 `bp-<pkg 全路径>-NNN`
 * 与常规片名 `bp-<root>-NNN` 在 root 含连字符时完全同形（sanitize 已把点换成连字符），
 * 名字不是可靠判据；总量是 manifest 行与分片文件都能算出来的量。
 *
 * ⚠️ 本检查**必须是诚实的**：§4.1 的贪心算法只在"package 首个单元恰落在分片开头"时才保证
 * 该不变量（ledger R2 记有反例：前片有残余空间时装得下 package 前半、装不下后半）。
 * §4.1 是规范性算法，不得为实现这条不变量而改算法；若真实数据触发反例，本检查会红 ——
 * 那是 **spec 级发现**，上报人类搭档，**不得放宽本检查**。
 */
export function checkPackageNotSplit(frags, threshold) {
  const total = new Map();          // pkg -> 单元行数合计
  const where = new Map();          // pkg -> Set<分片名>
  for (const f of frags) {
    for (const u of f.units) {
      if (!u.pkg) continue;
      total.set(u.pkg, (total.get(u.pkg) ?? 0) + u.lines);
      if (!where.has(u.pkg)) where.set(u.pkg, new Set());
      where.get(u.pkg).add(f.name);
    }
  }
  const split = [...where]
    .filter(([p, set]) => set.size > 1 && total.get(p) <= threshold)
    .map(([p]) => `${p}(共 ${total.get(p)} 行 / ${where.get(p).size} 片)`);
  if (split.length) return fail(`package 跨分片: ${split.join(', ')}`);
  return ok();
}

/** 按分片分组该源的行，返回 Map<fragName, rows[]>（组内按 line 升序） */
function groupByFrag(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.frag)) m.set(r.frag, []);
    m.get(r.frag).push(r);
  }
  for (const g of m.values()) g.sort((a, b) => a.line - b.line);
  return m;
}

/**
 * 从**已落盘的分片文件**重建单元：第 k 个符号起于 line_k，止于 line_{k+1}-1，最后一个止于 EOF。
 *
 * 为什么不直接用 manifest 的 (line, lines) 构造：layoutFragment 的正文就是
 * `header + 单元原文拼接`，不写 trailer（见 emit.mjs），所以按行号切出来的**就是单元原文本身**。
 * 于是无需给 manifest 加一个 `lines` 字段 —— 少一个会与分片失同步的冗余字段。
 * 反过来说：这条推理成立的前提是分片正文零改写（spec §4.4），完整性校验正是在守它。
 */
function fragmentUnitsFrom(dir, rows) {
  const list = [];
  for (const [frag, group] of groupByFrag(rows)) {
    const abs = join(dir, frag);
    if (!existsSync(abs)) return { error: `manifest 指向不存在的分片 ${frag}` };
    const lines = readFileSync(abs, 'utf8').split(/(?<=\n)/);
    const units = [];
    for (let i = 0; i < group.length; i++) {
      const from = group[i].line - 1;
      const to = i + 1 < group.length ? group[i + 1].line - 1 : lines.length;
      if (from < 0 || from >= lines.length) return { error: `行号越界: ${frag}:${group[i].line}` };
      units.push({
        name: group[i].name, pkg: group[i].pkg,
        lines: to - from, text: lines.slice(from, to).join(''),
      });
    }
    list.push({ name: frag, units });
  }
  return { list };
}

export function runChecks({ root, threshold = null }) {
  const dir = join(root, FRAGMENTS_DIR);
  const manifestPath = join(dir, 'manifest.jsonl');
  if (!existsSync(manifestPath)) { process.stderr.write('自检失败: manifest.jsonl 不存在\n'); return false; }
  const { meta, rows, corrupt } = parseManifest(readFileSync(manifestPath, 'utf8'));
  if (corrupt) { process.stderr.write('自检失败: manifest 损坏\n'); return false; }

  // 阈值以 manifest 记录为准 —— 分片就是按它切的。**不设默认值**：
  // 猜一个数字去校验别人的产物，只会制造假失败或假通过。
  const th = threshold ?? meta?.threshold ?? null;

  const failures = [];
  const allFrags = [];        // 跨源汇总：文件名唯一性/归属、片长、package 不跨片
  let checkedUnits = 0;

  for (const s of SOURCES) {
    const abs = join(root, s.path);
    if (!existsSync(abs)) {
      // 缺源**必须响亮失败**，不能 `continue` 跳过：静默跳过会让 --verify-only 在源文件已被
      // 删除/移走的树上照样打印「自检通过」并**退出 0** —— 而该源的单元与分片根本没被检查。
      // 那正是本项目反复点名的那类**假绿**（Ruling 17/19/24/25），且与切分路径自相矛盾：
      // 同一条件在 split-dts.mjs 的 readSource 里是抛错（`源文件不存在: …`），两条路径
      // 对"源集合"必须同口径。**不存在假红风险**：能产出产物的宿主必然源表齐全
      // （否则切分路径早就抛了），故要求它们在 verify 里出现不会破坏任何一个能工作的宿主。
      //
      // ⚠️ 本检查在循环里**必须排在 `parser === 'none'` 的 continue 之前**，且其上方不得有
      // 任何 continue：`parser: 'none'`（仅登记哈希、无符号行）的源同样在 SOURCES 里、
      // 同样被切分路径无条件 readSource ⇒ 只跳过**解析**、不得跳过**存在性**。
      // 顺序反了就是同一个假绿的第二次落地（实测：删 Typing/ue/index.d.ts 后
      // --verify-only 仍 exit 0，而同一棵树切分路径 exit 1）。这类源没有符号行，
      // 所以这条失败**只有一条**（不会另有 manifest 行级失败重复报告）。
      failures.push(fail(`${s.id}: 源文件不存在: ${s.path}（项目根 ${root}）`));
      continue;
    }
    if (s.parser === 'none') continue;      // 存在性已查过，这里只跳过**解析**（无符号可查）

    let units, markerPairs = null;
    try { ({ units, markerPairs } = parseSource(s.id, readFileSync(abs, 'utf8'))); }
    catch (e) { failures.push(fail(`${s.id}: ${e.message}`)); continue; }
    checkedUnits += units.length;
    if (!s.sliced) continue;

    const c = checkUnitsNonEmpty(s.id, units); if (!c.ok) failures.push(c);
    if (s.parser === 'markers') {
      const m = checkMarkerPairs(s.id, markerPairs, units.length); if (!m.ok) failures.push(m);
    }

    const built = fragmentUnitsFrom(dir, rows.filter((r) => r.src === s.id && r.sliced));
    if (built.error) { failures.push(fail(`${s.id}: ${built.error}`)); continue; }

    for (const f of built.list) allFrags.push({ ...f, src: s.id });

    // 完整性按**源**比对：分片重排了单元，行号回验不了，只能比内容。
    // 左侧必须按例外分支的同一规则展开 —— 否则超阈值单元在两侧不同构，
    // 会把**正常产出**判为失败（ledger R1）。threshold 未知时不做内容比对：
    // 宁可不报也不报假失败，而 th 缺失本身已在下文记为失败。
    if (th != null) {
      const left = expandUnits(units, th);
      const content = checkContentIntegrity(left, built.list.flatMap((f) => f.units));
      if (!content.ok) failures.push(fail(`${s.id}: ${content.detail}`));
    }
  }

  const names = checkUniqueFragNames(allFrags); if (!names.ok) failures.push(names);
  if (th == null) {
    // 数清楚 th 到底锁住了哪几项：片长、package 边界，以及循环里按 th 展开的**内容完整性**
    // （`if (th != null)` 那一处）。少报一项会让人以为内容完整性已经查过了。
    failures.push(fail('manifest 未记录 threshold，无法校验片长、package 边界与内容完整性'
      + ' —— 请用 --all 重跑以刷新 manifest'));
  } else {
    const len = checkFragmentLength(allFrags, th); if (!len.ok) failures.push(len);
    const pkg = checkPackageNotSplit(allFrags, th); if (!pkg.ok) failures.push(pkg);
  }

  const c1 = checkCompileIsolation(dir); if (!c1.ok) failures.push(c1);
  const c2 = checkManifestConsistency(root, rows); if (!c2.ok) failures.push(c2);

  for (const f of failures) process.stderr.write(`自检失败: ${f.detail}\n`);
  if (!failures.length) {
    process.stdout.write(`自检通过（${rows.length} 个符号 / ${checkedUnits} 个单元 / ${allFrags.length} 个分片）\n`);
  }
  return failures.length === 0;
}
