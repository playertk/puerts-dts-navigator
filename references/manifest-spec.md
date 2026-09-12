# manifest 规约

## 完整位置

```
<项目根>/Typing/ue/.fragments/manifest.jsonl
```

`manifest.jsonl` 与全部分片同目录。产物后缀是 **`.d.txt` 而不是 `.d.ts`**，这不是笔误：
`.fragments/` 位于 `Typing/` 下，而宿主 `tsconfig.json` 的 `typeRoots: ["Typing"]` 会自动加载其下任何
`.d.ts` —— 用 `.d.txt` 才能既与源文件同住一处、又不进编译（见 `troubleshooting.md`）。

## 格式：JSONL，一符号一行

- **第 1 行是 meta 记录**：全部源的哈希快照。它必须独立成行，校验才能只靠 `head -1` 完成，
  否则校验就得扫描整个文件。
- 其后**每个符号独占一行**，行与行互不影响，顺序不影响查询（Grep 命中即返回）。

> ⚠️ **严禁把 manifest 写成单行 minified JSON。** `Grep` 命中时返回的是**整行**：
> 单行 JSON 会让"查一个符号"变成"把整个索引倒进上下文"，方案直接失效。
> JSONL 的全部意义就在于让一次 Grep 只返回一行。

## meta 首行字段

```json
{"__meta__":1,"generated":"<ISO 时间戳>","threshold":1800,"sources":[{"id":"ue","path":"Typing/ue/ue.d.ts","sha1":"<sha1>","size":<字节数>,"mtime":"<ISO 时间戳>"},……]}
```

| 字段 | 说明 |
|---|---|
| `__meta__` | 记录格式版本号。与脚本预期不同 → 全部源强制重切（见 `regenerate.md`） |
| `generated` | 本次落盘时刻。是唯一"不是输入的函数"的字段，不参与"逐字节相同"类断言 |
| `threshold` | 切分时用的片长阈值。与本次命令行传入的不同 → 强制全量重切 |
| `sources[]` | **逐源**快照数组，每项含 `id` / `path` / `sha1` / `size` / `mtime` |

`sources[]` 是**数组且逐源独立**，这正是分目标增量执行的基础：能判断"是哪个源漂移了"，
因而不必因为一个源变了就重切全部源。`sha1` 是漂移判据，`size` / `mtime` 仅供展示。

## symbol 行字段

```json
{"name":"<符号名>","src":"ue","kind":"class","pkg":null,"extends":"UE.<父类>","frag":"<文件名>","line":<行号>,"sliced":true}
```

| 字段 | 说明 |
|---|---|
| `name` | 符号名。⚠️ **不唯一** —— 同名不同类型的符号确实存在。查询键是 `(name, kind)` |
| `src` | 所属源的短标识，对应 meta 的 `sources[].id`。**必填，且不可由 `frag` 前缀反推**：未切分源的 `frag` 直接指向原文件，与切分目标的命名约定无关 |
| `kind` | 声明种类：`class` / `enum` / `namespace` / `function` / `interface` / `type` / `const`。**随源而定，不是固定枚举**（大文件只产出 `class` 与 `enum`；`abstract class` 归一为 `class`）。必须保留 —— 见 `name` 不唯一 |
| `pkg` | 所属 package 全路径；非 `bp` 源为 `null` |
| `extends` | 父类限定名（如 `UE.DeveloperSettings`）；无则 `null` |
| `frag` | 目标文件。**基准由 `sliced` 决定，见下节** |
| `line` | 行号。**语义由 `sliced` 决定，见下节** |
| `sliced` | 该源是否被切分。`true` = 有分片；`false` = 无分片、`frag` 即原文件 |

源的短标识取值：`ue` / `bp` / `decorators` / `puerts` / `puerts-index` / `ffi` / `cpp` / `ue-index`。

## `frag` 的两个基准与 `sliced` 的两种读法

**`frag` 不是"相对于产物目录"的路径**。它的基准由 `sliced` 决定 —— 这个歧义必须消除，
否则会把原文件当成分片整读（或反过来）：

| `sliced` | 该源的状态 | `frag` 的基准 | `line` 的含义 | 读法 |
|---|---|---|---|---|
| `true` | 已切分 | `<项目根>/Typing/ue/.fragments/` | **分片内**行号 | `Read <项目根>/Typing/ue/.fragments/<frag>` |
| `false` | 未切分 | **项目根** | **原文件**行号 | `Read <项目根>/<frag>`，用 `offset` 只读目标附近 |

未切分源的 `frag` 直接是 `Typing/ue/puerts.d.ts`、`Typing/ffi/index.d.ts` 这类**原文件路径**。
`line` 是**原文件**行号，`sliced: false` 的源**没有分片** —— 所以也不存在"分片内行号"这回事。

`sliced` 字段的唯一目的就是消除这层歧义；引用它、不要靠 `frag` 的形态去猜。

## 查询键：`(name, kind)`，不是 `name`

- 主查询键：**`(name, kind)`**。同名不同 kind 的符号确实存在，只按 `name` 匹配会命中多行，
  取错行就会得出"查到的是别的东西"的结论。
- 次查询键：**`(frag, line)`**。一个 `(frag, line)` 在 manifest 中恰好出现一次，
  可用它反查该位置的符号名 —— 这也是"索引与分片是否一致"的判据。

## 手写查询示例

按名字找类：

```bash
grep -n '"name":"UMyType"' "<项目根>/Typing/ue/.fragments/manifest.jsonl"
```

按 `(name, kind)` 消歧：

```bash
grep -n '"name":"UMyType"' "<项目根>/Typing/ue/.fragments/manifest.jsonl" | grep '"kind":"class"'
```

只看某个源的行（跨切分目标定位"这个符号属于哪个源"）：

```bash
grep -n '"name":"UMyType"' "<项目根>/Typing/ue/.fragments/manifest.jsonl" | grep '"src":"bp"'
```

流程本身（校验哈希 → 查 manifest → 读分片）见 `lookup-workflow.md`；
重切与阈值语义见 `regenerate.md`；异常现象见 `troubleshooting.md`。
