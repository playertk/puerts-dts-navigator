# Puerts TypeScript 声明文件参考手册

## 目录

1. [ffi/index.d.ts — 外部函数接口（FFI）](#1-ffiindexdts--外部函数接口ffi)
2. [puerts/index.d.ts — Puerts 核心运行时 API](#2-puertsindexdts--puerts-核心运行时-api)
3. [ue/puerts.d.ts — UE 核心容器 & 类型映射](#3-uepuertsdts--ue-核心容器--类型映射)
4. [ue/puerts_decorators.d.ts — UE 装饰器系统](#4-uepuerts_decoratorsdts--ue-装饰器系统)
5. [ue/ue.d.ts — 引擎与模块的原生类型声明](#5-ueuedts--引擎与模块的原生类型声明)
6. [ue/index.d.ts — 类型入口聚合](#6-ueindexdts--类型入口聚合)
7. [整体架构总结](#7-整体架构总结)

---

## 1. ffi/index.d.ts — 外部函数接口（FFI）

作用：允许 JavaScript/TypeScript 直接调用原生 C/C++ DLL 中的函数。

### 核心功能

| 功能 | API | 说明 |
|------|-----|------|
| 类型体系 | `PrimitiveTypes`、`TypeInfo` | 定义 `void`、`uint8`、`int8`、`float`、`double`、`pointer`、`cstring` 等，`TypeInfo` 提供 `size`、`alloc`、`read`、`write`、`get`、`set` 方法 |
| 类型转换 | `typeInfo()` | 将基本类型字符串或自定义类型转换为 `TypeInfo` 对象 |
| 结构体 | `makeStruct()` | 用 JS 对象描述创建 C 结构体类型 |
| 指针 | `makePointer()` | 创建指针类型包装 |
| 绑定函数 | `binding()` | 绑定原生函数地址（`funcIndex`），指定 ABI 约定、返回值类型、参数类型，返回可直接调用的 JS 函数 |
| 闭包 | `closure.alloc()`、`closure.func()`、`closure.free()` | 从 JS 函数创建回调闭包，获取函数指针，释放闭包 |

### 典型用途

在 Puerts 中直接调用第三方原生库，无需编写 C++ 插件包装层。

---

## 2. puerts/index.d.ts — Puerts 核心运行时 API

作用：提供 Puerts 运行时的核心工具函数，是 JS 与 UE/原生世界之间的桥梁。

### 核心功能分类

| 功能分类 | API | 说明 |
|----------|-----|------|
| 引用类型 | `$Ref<T>` / `$InRef<T>` / `$ref()` / `$unref()` / `$set()` | 支持按引用传递参数（类似 C++ 的 `&`），用于输出参数场景 |
| 字符串/内存互操作 | `cstring` 类型、`toCString()`、`toCPtrArray()` | 在 JS 字符串和 C 内存 Buffer 之间转换 |
| Blueprint 混合/类操作 | `blueprint()`、`blueprint.tojs()`、`blueprint.mixin()` / `unmixin()` | 核心功能：将 JS 类混合到 UE Blueprint 类中，或从 UE 类获取 JS 类引用 |
| 委托管理 | `toManualReleaseDelegate()`、`releaseManualReleaseDelegate()`、`toDelegate()` | 创建和管理 UE 委托的 JS 绑定 |
| 事件系统 | `on()` / `off()` / `emit()` | Puerts 内部事件总线，用于监听引擎生命周期等事件 |
| DLL 动态加载 | `load<T>(dllpath)` | 动态加载原生 DLL 并返回其导出接口 |
| 参数获取 | `argv.getByIndex()` / `argv.getByName()` | 在 Blueprint 调用 JS 函数时获取调用上下文参数 |
| 对象引用控制 | `setJsTakeRef()` | 设置 JS 是否持有 UE 对象的引用（影响 GC） |
| 已废弃 | `makeUClass()` | 已废弃，推荐使用 `mixin` 替代 |

---

## 3. ue/puerts.d.ts — UE 核心容器 & 类型映射

作用：定义 UE 容器类型在 TypeScript 中的映射接口，以及 UE 基本类型的 TS 别名。

### 容器类型接口

| 容器类型 | 说明 |
|----------|------|
| `$Delegate<T>` | 单播委托绑定接口 — `Bind`、`Unbind`、`IsBound`、`Execute` |
| `$MulticastDelegate<T>` | 多播委托 — `Add`、`Remove`、`Broadcast`、`Clear` |
| `TArray<T>` | 映射 UE `TArray` — `Num`、`Add`、`Get`、`Set`、`Contains`、`RemoveAt`、`Empty`，可迭代 |
| `TSet<T>` | 映射 UE `TSet` — 与 `TArray` 类似接口 |
| `TMap<TKey, TValue>` | 映射 UE `TMap` — `Add`、`Get`、`Set`、`Remove`、`Empty`，可迭代 |
| `FixSizeArray<T>` | 固定大小数组映射 |
| `TSharedPtr<T>` | 共享指针映射 |
| `TWeakObjectPtr<T>`、`TSoftObjectPtr<T>`、`TLazyObjectPtr<T>` | UE 智能指针/对象引用类型 |
| `TSubclassOf<T>`、`TSoftClassPtr<T>` | 类引用类型 |

### 工具函数

| 函数 | 说明 |
|------|------|
| `NewArray<T>()`、`NewSet<T>()`、`NewMap<T>()` | 在 JS 端创建 UE 容器实例 |
| `NewObject()`、`NewStruct()` | 在 JS 端创建 UE 对象/结构体 |
| `FNameLiteral()` | 创建 UE `FName` |
| `ContainerKVType<T>` | 条件类型映射：将内置类型常量映射为 JS 类型 |

---

## 4. ue/puerts_decorators.d.ts — UE 装饰器系统

作用：提供 TypeScript 装饰器，允许以声明式语法在 JS 类上标记 UE 元数据（等价于 C++ 的 `UPROPERTY()`、`UFUNCTION()`、`UCLASS()` 宏）。

### 装饰器命名空间

#### `ue.uclass` — 类级别元数据

- `@uclass(...)` 装饰器函数
- 元数据键：`BlueprintType`、`Blueprintable`、`NotBlueprintable`、`Abstract`、`Transient`、`Deprecated` 等
- `@umeta(...)` 设置更细粒度元数据：`DisplayName`、`ToolTip`、`BlueprintSpawnableComponent` 等

#### `ue.ufunction` — 函数级别元数据

- `@ufunction(...)` 装饰器
- 函数说明符：`BlueprintImplementableEvent`、`BlueprintNativeEvent`、`BlueprintCallable`、`BlueprintPure`、`Server`、`Client`、`NetMulticast`、`Reliable`、`Exec`、`CallInEditor` 等
- 函数元数据键：`ToolTip`、`CompactNodeTitle`、`DeprecatedFunction`、`Category` 等

#### `ue.uproperty` — 属性级别元数据

- `@uproperty(...)` 装饰器
- 属性说明符：`EditAnywhere`、`VisibleAnywhere`、`BlueprintReadWrite`、`BlueprintReadOnly`、`Replicated`、`ReplicatedUsing`、`Interp`、`SaveGame`、`Category` 等
- 属性元数据键：`ClampMin`、`ClampMax`、`UIMin`、`UIMax`、`DisplayName`、`EditCondition`、`ExposeOnSpawn` 等

#### `ue.rpc` — RPC/网络辅助

- `rpc.flags()`、`rpc.condition()` — 设置网络复制条件
- 枚举：`FunctionFlags`、`PropertyFlags`、`ELifetimeCondition`

#### 顶层枚举

- `FunctionFlags`、`FunctionExportFlags`、`ClassFlags`、`PropertyFlags`、`EPropertyHeaderExportFlags`

#### 顶层函数

- `set_flags()` / `clear_flags()` — 手动设置/清除函数标志
- `edit_on_instance()` / `no_blueprint()` — 快捷装饰器

---

## 5. ue/ue.d.ts — 引擎与模块的原生类型声明

作用：`ue/ue.d.ts`（生成）：引擎与模块的原生 C++ 类型声明，**规模最大** —— 引擎本身与各模块（插件）暴露给 TypeScript 的类与枚举都声明在这里。

- **它是生成物**：由 UE 编辑器内的代码生成命令产出，随引擎版本与项目启用的模块变化（低频漂移）。
  该命令**无法**从命令行 / UAT / CI 调用，原因见 `regenerate.md`。
- **禁止整读该文件**：它的体量足以撑爆单次读取。检索一律走预生成的分片与 manifest 索引，
  流程见 `lookup-workflow.md`，产物位置与字段见 `manifest-spec.md`。
- 引用方式与其他 UE 类型一致：`import * as UE from 'ue'`，如 `UE.Actor`。
- 分片按声明名排序装箱，故**分片内的顺序与源文件物理顺序不同**；但每个声明单元内部**文本逐字节原样**，
  仅单元之间重排。因此不要用分片行号反查源文件 —— 也没必要（只读分片即可）。

---

## 6. ue/index.d.ts — 类型入口聚合

- 把 `ue.d.ts`、`puerts.d.ts`、`puerts_decorators.d.ts` 以及生成的 `ue_bp.d.ts` 聚合到 `ue` 模块
  （该文件正文即一组 `/// <reference path="…" />` 指令）
- `ue.d.ts` 是引擎与模块的原生 C++ 类型声明（规模最大）；`ue_bp.d.ts` 是在运行 Puerts 代码生成步骤时自动生成的，包含用户项目中所有暴露给 JS 的 UE Blueprint 类/结构体/枚举的 TypeScript 声明
- 于是 `import * as UE from 'ue'` 一次就能拿到上述全部类型

---

## 7. 整体架构总结

| 层级 | 模块 | 职责 |
|------|------|------|
| 运行时桥接 | `puerts/` | JS ↔ 原生世界的基础设施：引用传递、委托绑定、Blueprint 混合、DLL 加载 |
| 原生互操作 | `ffi/` | 绕过 UE 层，直接调用任意 C/C++ DLL 函数 |
| 引擎与模块类型 | `ue/ue.d.ts`（生成） | 引擎与模块的原生 C++ 类型声明，规模最大 |
| UE 类型映射 | `ue/puerts.d.ts` | UE 容器（TArray/TSet/TMap）的 TS 接口定义 |
| 元数据装饰器 | `ue/puerts_decorators.d.ts` | 用装饰器语法编写 UE 反射元数据，替代 C++ 宏 |
| 项目类型声明 | `ue/ue_bp.d.ts`（生成） | 包含项目中自定义 Blueprint 类的 TS 类型信息 |

这构成了一个完整的 **TypeScript 驱动 UE 开发框架**：工程师可以用纯 TS 编写 UE 逻辑，通过装饰器标记 UPROPERTY/UFUNCTION/UCLASS 元数据，使用 Puerts 运行时 API 与 UE 对象交互，并通过 FFI 直接调用原生库——全程无需编写 C++ 代码。

---

## 这些文件如何被索引

本手册回答"某个模块提供哪些 API、怎么写"，**不**回答"某个符号在第几行"。定位符号走索引：

- 三个体量最大的源（`ue.d.ts`、`ue_bp.d.ts`、`puerts_decorators.d.ts`）已被预先切成小片，
  放在 `<项目根>/Typing/ue/.fragments/`，配套一份 `manifest.jsonl` 索引；其余源未切分、`frag` 直指原文件。
- **查符号的流程**（校验哈希 → Grep manifest → 按 `sliced` 分流读片）：`lookup-workflow.md`
- **manifest 字段、`frag` 的两个基准与 `sliced` 的两种读法**：`manifest-spec.md`
- **索引过期 / 分片缺失时重新切分**：`regenerate.md`
- **查不到符号、路径失效、结果异常**：`troubleshooting.md`

索引已经把"读原文件"这一步移出回路 —— 不要为了找一行声明而打开 `ue.d.ts`。
