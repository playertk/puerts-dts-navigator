---
name: puerts-dts-navigator
description: 在 Puerts 项目里查询或使用 UE / PuerTS 类型定义时使用 —— 包括查引擎类型与蓝图类型的定义位置、理解生成物 ue.d.ts / ue_bp.d.ts 的规模与结构、TypeScript 侧调用 UE 容器与委托、使用装饰器标注 UCLASS/UPROPERTY/UFUNCTION。分片索引过期或缺失时也走本技能。禁止直接 Read Typing/ue/ue.d.ts 原文件。
---

# PuerTS 类型定义导航

`Typing/ue/ue.d.ts` 是生成物，规模随引擎与项目变化，**足以撑爆单次读取**。
本技能通过预生成的分片与 manifest 索引来查询类型，**禁止直接打开该原文件**。

## 按场景跳转

- 查一个类 / 枚举 / 蓝图类型的定义 → `references/lookup-workflow.md`
- 理解 manifest 字段、手写查询、两种读法 → `references/manifest-spec.md`
- 分片过期 / 缺失 / 需要重新切分 → `references/regenerate.md`
- 查不到符号、路径失效、结果异常 → `references/troubleshooting.md`
- 在 TS 里用 UE 容器 / 委托 / 装饰器 / 运行时 API → `references/api-usage.md`

## 两条硬规则

1. **先校验、再查询**：任何查询前先确认索引与源文件一致（做法见 `lookup-workflow.md`）。
2. **不要重新生成 `.d.ts`**：本技能只能重新**切分**。重新生成需要 UE 编辑器内的 `Puerts.Gen`，无法从命令行代劳（原因见 `regenerate.md`）。
