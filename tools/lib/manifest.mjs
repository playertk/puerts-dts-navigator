// manifest 的构建与合并。零依赖。
// 本文件是全设计**唯一会静默丢数据**的地方（spec §5.5）—— 出错不报错。
// 因此它只负责"行的归属与合并"，不与解析/渲染纠缠，并被单独测试。
export const META_VERSION = 1;

const SYMBOL_FIELDS = ['name', 'src', 'kind', 'pkg', 'extends', 'frag', 'line', 'sliced'];

export function buildMeta({ sources, threshold, now }) {
  return {
    __meta__: META_VERSION,
    generated: now,
    threshold,
    sources: sources.map((s) => ({ id: s.id, path: s.path, sha1: s.sha1, size: s.size, mtime: s.mtime })),
  };
}

/** 行字段顺序固定 => 序列化逐字节确定（§7 确定性检查与"逐字节不变"断言都依赖它） */
export function buildRows(src, placements) {
  return placements.map((p) => {
    const u = p.unit;
    return {
      name: u.name,
      src,
      kind: u.kind,
      pkg: u.pkg ?? null,
      extends: u.extends ?? null,
      frag: p.frag,
      line: p.line,
      sliced: p.sliced,
    };
  });
}

/**
 * JSONL，一行一记录。**严禁单行 minified JSON**：11 MB 的单行 JSON 会让 Grep 命中任一
 * 符号时返回整行，等于把整个索引倒进上下文，方案直接失效（spec §5.1）。
 */
export function serialize(meta, rows) {
  const parts = [JSON.stringify(meta)];
  for (const r of rows) parts.push(JSON.stringify(r));
  return parts.join('\n') + '\n';
}

export function parseManifest(text) {
  const lines = String(text).split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { meta: null, rows: [], corrupt: true };
  let meta;
  try { meta = JSON.parse(lines[0]); } catch { return { meta: null, rows: [], corrupt: true }; }
  if (!meta || !Array.isArray(meta.sources) || meta.__meta__ !== META_VERSION) {
    return { meta: null, rows: [], corrupt: true };
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    try { rows.push(JSON.parse(lines[i])); } catch { return { meta, rows: [], corrupt: true }; }
  }
  return { meta, rows, corrupt: false };
}

export { SYMBOL_FIELDS };

/**
 * 决定本次运行处理哪些源。
 *
 * 强制全量的判据（spec §5.5 表）：threshold 变化 / __meta__ 版本变化 / manifest 缺失或损坏。
 * 阈值变化会改变**全部**分片边界，局部重切会产出互相矛盾的分片集。
 */
export function planRun({ prev, sources, threshold, targets, force }) {
  const allIds = sources.map((s) => s.id);

  if (!prev || !prev.meta || prev.corrupt) {
    return { mode: 'all', stale: allIds, reason: 'manifest 缺失或损坏' };
  }
  if (prev.meta.threshold !== threshold) {
    return { mode: 'all', stale: allIds, reason: `threshold 变化 ${prev.meta.threshold} -> ${threshold}` };
  }

  const prevById = new Map(prev.meta.sources.map((s) => [s.id, s]));
  const pool = targets ? sources.filter((s) => targets.includes(s.id)) : sources;
  const stale = [];

  for (const s of pool) {
    const before = prevById.get(s.id);
    if (!before) { stale.push(s.id); continue; }          // 新增源
    if (force || before.sha1 !== s.sha1) stale.push(s.id);
  }
  if (!stale.length) return { mode: 'partial', stale: [], reason: null };
  return { mode: 'partial', stale, reason: null };
}

/**
 * 合并 symbol 行：src ∉ stale 的行**原样保留**（只丢 stale 源的行），stale 源换成新行。
 *
 * 输出按 `order`（= SOURCES 的 id 顺序）**分组**。这一条不是洁癖：
 * 若按"保留的行 + 本次新行"顺序拼接，manifest 的字节内容会随"本次处理了哪些源、
 * 按什么顺序处理"漂移 —— 于是「--all」与「逐源 --force」产出的文件不同，
 * Task 9 的增量等价性检查无从成立，Agent 也无法用哈希判断索引是否变化。
 *
 * 未处理源的行**逐字段原样保留**，这就是"增量不丢行"的全部含义。
 */
export function mergeRows(prevRows, staleSet, newRowsBySrc, order) {
  // ★ 硬断言：进了 staleSet 却没**提供数组** ⇒ 旧行已在下面被丢弃、新行又不存在 ⇒ **静默丢行**。
  // 这正是本任务要防的失效模式，故**响亮失败**，而不是默默产出少几行的索引
  //（与 §4.3「片名冲突必须响亮失败、不得自动改名」同理）。
  // 判据用 `Array.isArray(get(...))` 而非真值判断：真值判断会放行"**真值但非数组**"的值，
  // 而它们在下面的 `...spread` 处表现各异 —— 非可迭代值（如 `42`）抛一个与成因无关的
  // TypeError，**可迭代值（如字符串 `'oops'`）则被静默展开成逐字符的垃圾行**，比抛错更糟。
  // 注意空数组 `[]` 是**合法**的新行集（"确实切出了 0 条行"），必须放行 —— 但真值判断同样放行它，
  // 故 `[]` **不是**该判据的理由，真正的理由是上面那两类"真值但非数组"的值。
  // （`get` 对缺席键返回 `undefined`，故"缺席"与"键在但非数组"两种情形一并覆盖。）
  // 调用方（Task 7）必须**恰好**把 `plan.stale` 作为 staleSet 传入，不要按 `--target` 二次过滤。
  for (const id of staleSet) {
    if (!Array.isArray(newRowsBySrc.get(id))) {
      throw new Error(`mergeRows: 源 ${id} 被标记为 stale 但未提供新行，拒绝产出会丢行的 manifest`);
    }
  }
  const bySrc = new Map();
  for (const r of prevRows) {
    if (staleSet.has(r.src)) continue;
    if (!bySrc.has(r.src)) bySrc.set(r.src, []);
    bySrc.get(r.src).push(r);
  }
  for (const [src, rows] of newRowsBySrc) {
    if (staleSet.has(src)) bySrc.set(src, rows);
  }

  const out = [];
  const emitted = new Set();
  for (const id of order) {
    if (!bySrc.has(id)) continue;
    out.push(...bySrc.get(id));
    emitted.add(id);
  }
  for (const [id, rows] of bySrc) {          // order 之外的源兜底，绝不丢行
    if (!emitted.has(id)) out.push(...rows);
  }
  return out;
}

/**
 * 重写 meta：**只更新 stale 源的 sha1/size/mtime**，其余源**原值原样保留**。
 * 重算未处理源的哈希会掩盖"该源已漂移但本次未处理"，使下次增量判断失效（spec §5.5）。
 */
export function mergeMeta(prevMeta, sources, staleSet, threshold, now) {
  // prevMeta.sources 可能缺席（manifest 缺失/损坏时调用方传 { sources: [] }），故用 ?? 兜底
  const prevById = new Map((prevMeta.sources ?? []).map((s) => [s.id, s]));
  return {
    __meta__: META_VERSION,
    generated: now,
    threshold,
    sources: sources.map((s) => {
      const before = prevById.get(s.id);
      if (staleSet.has(s.id) || !before) {
        return { id: s.id, path: s.path, sha1: s.sha1, size: s.size, mtime: s.mtime };
      }
      return { id: s.id, path: s.path, sha1: before.sha1, size: before.size, mtime: before.mtime };
    }),
  };
}
