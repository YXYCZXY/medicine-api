# 千方记 P2_VALIDATION_FAILED 根因排查报告

**排查日期：** 2026-11-12  
**项目路径：** `F:\medicine\medicine-api`  
**范围：** 只读排查与修复方案设计，未修改生产源码  
**触发日志：**

```text
WARN [AiController] P2_SAFE_FALLBACK:P2_VALIDATION_FAILED
```

---

## 结论摘要

这次日志只能证明：模型返回了可解析的 JSON 对象，随后被 P2 Validator 拒绝。现有日志没有记录是哪一条断言失败，因此还不能把某一种字段错误定成唯一根因。

本地终端在 `2026/11/12 19:09:32` 只有这一行警告，前后没有模型输出、用户原文或更细的错误码。现有 P2 Validator、模型客户端、Dictionary Matcher 共 89 项 Vitest 均通过。

最可能的根因是：模型返回了语法合法的 JSON，但没有满足 Validator 的闭集协议；其中最明确的协议缺口，是 Prompt 允许「引用字典标签」，Validator 却要求字典候选五个字段与 Matcher 输出完全一致。

---

## 1. 实际调用链

`POST /ai/chat` 的 P2 路径如下。

1. `AiController.chat`（`src/modules/ai/ai.controller.ts`）先调用 `P1Service.process`。
2. 只有 `outcome.action === 'CONTINUE_TO_P2'` 才进入 P2。请求时间由服务端生成，时区固定为 `UTC`。
3. `P2OrchestratorService.process`（`src/modules/ai/p2/p2-orchestrator.service.ts`）依次执行：
   - `P2EntryGuardService.check`：只接受医疗 Segment，且必须与 `allowedSegmentIds` 完全一致。
   - `P2DictionaryContextService.load`：经 `UserDictionariesService.findAll()` 读当前用户字典，得到 `available`、`empty` 或 `unavailable`。
   - `P2DictionaryMatcherService.match`：只做字面和显式别名匹配。
   - `buildP2IntentModelRequest`：组装模型输入。
   - `P2IntentModelClientService.analyze`：系统指令加 JSON 用户消息，`responseFormat: 'json'`。
   - `OllamaService.generate`：向 `/api/chat` 发送 `format: "json"`。这里只要求「是 JSON」，不发送 P2 Schema。
   - `JSON.parse` 成功且结果是对象后，原样交给 Validator。
   - `P2IntentValidatorService.validate` 失败则返回 `SAFE_FALLBACK / P2_VALIDATION_FAILED`。
4. Controller 只记录 `P2_SAFE_FALLBACK:${reason}`，然后仍用 P1 结果构建原有 HTTP 响应。

因此这条日志的含义是：Ollama 通信成功，JSON 解析成功，对象进入了 Validator，某条 `assert` 失败。

| 失败类型 | 对外 reason |
|---|---|
| JSON 损坏 / 空响应 / 非对象 | `MODEL_OUTPUT_INVALID` |
| 超时 / 网络错误 | `MODEL_FAILED` |
| Validator 断言失败 | `P2_VALIDATION_FAILED` |

---

## 2. 已确认事实

每项结论均来自当前源码对照。

### 2.1 失败被折叠成一个无分类异常

- `P2IntentValidationError` 的消息固定为 `P2_VALIDATION_FAILED`，不带规则编号（`p2-intent-validator.service.ts` 第 14–18、531–536 行）。
- Orchestrator 把该异常和任何其他验证异常都映射为同一个 fallback（`p2-orchestrator.service.ts`）。

### 2.2 13 种意图参数形状：Prompt 与 Validator 一致

`medicine.search` 在系统指令中已要求：

```json
{
  "medicine_names": ["布洛芬"],
  "query_focus": "inventory_quantity",
  "keywords": []
}
```

对应源码：

- Prompt：`p2-intent-model.contract.ts` 第 122–128 行
- Validator：`p2-intent-validator.service.ts` 第 271–286 行

`parameters: {}` 会被拒绝；Prompt 也没有把空对象写成有效参数。

### 2.3 Intent 外壳字段一致

每个 intent 必须包含：

- `intent_id`
- `type`
- `source_segment_ids`
- `state`
- `parameters`
- `dictionary_candidates`
- `missing_fields`

Prompt 第 120 行已写明；Validator 用闭集 `keys()` 强制恰好这些字段。

### 2.4 字典候选：Validator 比 Prompt 更严（已确认的协议缺口）

Validator 要求意图里的每个候选同时满足：

1. 恰好 5 个字段：`kind`、`dictionary_value`、`matched_concept`、`source_text`、`relation`
2. 标签属于当前用户字典
3. 五个字段组成的元组必须出现在本次请求的 `dictionary_candidates` 中

关键代码：`p2-intent-validator.service.ts` 第 189–204、474–483 行。

Prompt 对应句子只写了：

> dictionary_candidates 只能引用输入 dictionary 中确实存在的标签

没有要求从输入 `dictionary_candidates` 原样复制，也没有列出候选的五个字段和四种 `relation`。

这个协议缺口已经由源码对照确认。它是否就是 `19:09:32` 那一次的失败点，日志无法证明。

### 2.5 其他已确认行为

| 行为 | 结论 |
|---|---|
| 空的 `dictionary_candidates: []` | 合法；即使请求里已有 Matcher 候选 |
| 同一 Segment 被多个意图引用 | 允许；同一意图内部禁止重复 ID |
| 授权 Segment 覆盖 | 必须被意图或 `unresolved_segments` 覆盖，两边不能重叠 |
| 查询意图空关键词数组 | `keywords: []` 合法；拒绝空白元素 `""` |
| 正常缺参 | `needs_clarification` + 非空 `missing_fields` 合法 |
| 字典三态 | `available` / `empty` / `unavailable` 均有测试覆盖 |
| `allowed_intent_types` | 请求固定写入全部 13 种，与 Validator 集合相等检查一致 |
| Segment 白名单 | 来自 `P1RouterService` 重新推导，不使用模型自报的 `p2_segment_ids` |
| Ollama JSON 模式 | 只约束「是 JSON」，不发送 P2 Schema |
| 类型断言 | `as P2IntentModelResponse` 在全部断言之后，不会掩盖运行时失败 |

---

## 3. 可能导致失败的原因

按优先级排列。

### P1 — 高概率但待验证：字典候选未原样复制

模型输出了字典候选，但没有按五字段原样复制 Matcher 结果。

- Prompt 只要求「引用 dictionary 中存在的标签」
- Validator 要求五元组完全相同
- 模型改 `source_text`、`matched_concept`、`relation`，或自行使用 `semantic_candidate` / `group_member`，都会失败
- Matcher 只会生成 `exact` 和 `alias`

### P2 — 高概率但待验证：闭集字段违规或空值

嵌套对象多了字段，或可选字段写成 `null`、`""`。

- Prompt 只对顶层声明了「必须且只能包含」
- Validator 的 `keys()` 对 intent、parameters、候选、selector、time_range、missing field 都是闭集
- `limit: null`、`"name": ""`、额外的 `note` / `confidence` 都会失败

### P3 — 高概率但待验证：意图参数形状偏离

例如：

- `query_focus` 不在四个枚举内
- 漏掉 `keywords`
- `limit` 变成字符串
- `start` 无法被 `Date.parse` 解析
- `ready` 与 `missing_fields` 不一致
- 写操作标成 `ready` 但字段为空

这些规则 Prompt 已经写了，属于模型未遵守，不是 Schema 遗漏。

### P4 — 高概率但待验证：Segment 覆盖不完整

- 漏掉某个输入 Segment
- 引用了输入中不存在的 ID
- 同一个 ID 既在意图里又在 `unresolved_segments` 里

### P5 — 已确认的观测限制

以上任何一条都会显示成同一行日志。没有原始模型输出，不能从这一行反推是哪一条。

### P6 — 仅理论可能：Segment ID 格式不一致

P1 实际 ID 不是 `seg_n`，P2 模型却改写成 `seg_1`。请求会原样传入真实 ID，Validator 做精确匹配。

### P7 — 仅理论可能：字典不可用时仍输出候选

用户字典不可用或为空时，模型仍输出候选。代码会拒绝，但是否发生取决于当时的字典状态，日志里没有这个状态。

### 排除项

没有发现 Validator 会把「空关键词查询」或「明确标记为需澄清的缺参写入」误判为失败。现有测试把这两种情况定义为合法。

---

## 4. 协议一致性检查

对照：

- `src/modules/ai/p2/schemas/p2.schema.ts`
- `src/modules/ai/p2/p2-intent-model.contract.ts`
- `src/modules/ai/p2/p2-intent-validator.service.ts`

| 规则 | Schema | Prompt / Request | Validator | 结论 |
|---|---|---|---|---|
| 13 种意图及参数形状 | `P2IntentParametersMap` | 第 14–28、122–128 行 | `validParameters` | 一致 |
| `medicine.search` 三字段和四个 `query_focus` | 第 116–120 行 | 第 123 行 | 第 271–286 行 | 一致，Prompt 没有漏字段 |
| intent 七字段 | `P2IntentBase` | 「必须包含」 | 恰好这七个键 | Prompt 没有声明禁止额外字段 |
| 顶层两个字段 | `P2IntentModelResponse` | 「必须且只能包含」 | 闭集 | 一致 |
| 字典候选 | 五个字段的接口 | 只提到字典标签必须存在 | 五字段闭集，且必须是请求候选的精确子集 | **Prompt 与 Validator 冲突** |
| `state` / `missing_fields` | 两种状态 | 已写明 | 第 177–181 行 | 一致 |
| Segment 覆盖 | ID 必须来自授权集合 | 每个片段要被引用或列入 unresolved | 并集必须相等，且不能重叠 | 重叠禁止只在 Validator 中明确 |
| 空关键词数组 | `string[]` | `string[]` | 空数组通过，空白元素拒绝 | 运行时比 TypeScript 更严，测试已固定为故意行为 |
| 可选字段 | `field?: string` | `?` 记号 | `null` 和 `""` 都拒绝 | Prompt 没说「没有就省略键」 |
| 字典三态 | 三种状态 | 请求中会传入 | 不可用时不建标签表；有候选则拒绝 | 一致 |
| 授权类型 | 13 种 | 请求固定带全部 13 种 | 集合必须相等 | 生产路径一致 |

Schema、请求构造和 Validator 之间没有互相矛盾的意图类型或 `medicine.search` 参数定义。已确认的定义冲突集中在字典候选，以及 Prompt 没有把 Validator 的闭集、空值规则写完整。

---

## 5. 最小复现方案

现有测试已经覆盖这条最可疑的协议缺口，不需要改源码：

```bash
yarn vitest run src/modules/ai/p2/p2-intent-validator.service.spec.ts
```

重点看这两项：

1. **拒绝字典中真实存在，但不属于 Matcher 输入候选的标签**  
   标签仍是字典中的 `发热`，只把 `source_text` 从 `发烧` 改成 `高烧`，即被拒绝。

2. **通过合法 medicine.search 意图**  
   `dictionary_candidates: []` 可以通过。  
   这说明失败来自「错误地填写候选」，不是「没有填写候选」。

若要在下一次真实请求中定位，应先增加只含分类码的诊断，再复现一次 `POST /ai/chat`。在此之前无法用当前日志稳定复现唯一字段错误。

---

## 6. 最小修复方案

### 6.1 补齐 Prompt（优先）

修改文件：`src/modules/ai/p2/p2-intent-model.contract.ts` 中的 `P2_INTENT_SYSTEM_INSTRUCTION`。

补上 Validator 已经强制、但 Prompt 没写清的规则：

1. 每一层对象都只能包含规定字段。
2. 可选字段没有值时省略该键，不能输出 `null` 或空字符串。
3. 意图中的 `dictionary_candidates` 只能从输入 `dictionary_candidates` 原样挑选；`kind`、`dictionary_value`、`matched_concept`、`source_text`、`relation` 五个值都不得改写。没有对应线索时使用 `[]`。
4. 不得根据 `dictionary.values` 自行构造候选，不得把 `relation` 改成 `semantic_candidate` 或 `group_member`。
5. 每个输入 Segment 恰好属于「被某个意图引用」或「出现在 unresolved_segments」之一。
6. 即使 `needs_clarification`，`parameters` 仍必须是该意图的完整形状；数组用 `[]`，`query_focus` 仍必须是四个枚举之一。

这样修改的是模型指令，不是校验门槛。现有安全测试应继续全部通过。

### 6.2 增加脱敏诊断分类码

给 `P2IntentValidationError` 增加不含业务内容的分类码，例如：

- `INVALID_TOP_LEVEL`
- `INVALID_INTENT_PARAMETERS`
- `INVALID_SEGMENT_REFERENCE`
- `INVALID_SEGMENT_COVERAGE`
- `INVALID_DICTIONARY_CANDIDATE`
- `INVALID_STATE`

Orchestrator 对外仍返回 `P2_VALIDATION_FAILED`，开发日志只追加分类码，例如：

```text
P2_VALIDATION_FAILED:INVALID_DICTIONARY_CANDIDATE
```

**禁止记录：**

- 用户原文
- Segment 正文
- 字典标签
- 候选对象
- 模型全文

### 6.3 明确不做的事

- 不把 Validator 放宽到「只要标签在用户字典里就接受」
- 不在未拿到分类码前修改 P1 Router 或 Ollama 调用方式
- 不删除或绕过 P2 Validator
- 不将验证失败的模型输出强制转换为合法类型
- 不提前开发 P3/P4

---

## 7. 安全影响评估

上述修复：

- **不改变** P1 Router 的授权 Segment
- **不删除或绕过** P2 Validator
- **不把** 未验证输出送往 P3
- **不改变** 字典读取方式
- **不改变** `POST /ai/chat` 的响应体

分类码只描述失败规则，不包含健康信息。若日志中写入字段值、Segment 文本或模型原文，才会扩大敏感数据暴露面，因此明确排除。

---

## 8. 最终结论

| 问题 | 结论 |
|---|---|
| 最可能的根因是什么？ | 模型返回了语法合法的 JSON，但没有满足 Validator 的闭集协议；最明确的协议缺口是字典候选「Prompt 只要求标签存在，Validator 要求五字段原样复制」。 |
| 目前证据是否足以确认？ | 不足以确认 `19:09:32` 那一次就是这个缺口；也可能是额外字段、`null`、参数枚举或 Segment 覆盖。 |
| 推荐优先修复哪个问题？ | 先补齐 Prompt 中的原样候选和闭集规则，并加上不含敏感内容的验证分类码。 |
| 是否需要进一步获取经脱敏的诊断信息？ | 需要。下一次失败只要出现分类码，就可以确认该修 Prompt 还是修某一条校验。在看到这个分类码之前，不建议放宽任何校验。 |

---

## 附录：相关文件清单

```text
src/modules/ai/
├── ai.controller.ts
├── ai.module.ts
├── p1/
│   ├── p1.service.ts
│   ├── p1-router.service.ts
│   └── schemas/p1.schema.ts
├── p2/
│   ├── schemas/p2.schema.ts
│   ├── p2-entry-guard.service.ts
│   ├── p2-dictionary-context.service.ts
│   ├── p2-dictionary-matcher.service.ts
│   ├── p2-intent-model.contract.ts
│   ├── p2-intent-model-client.service.ts
│   ├── p2-intent-validator.service.ts
│   ├── p2-orchestrator.service.ts
│   └── p2-intent-validator.service.spec.ts
└── llm/
    ├── llm.interface.ts
    └── ollama.service.ts

src/modules/user-dictionaries/
├── user-dictionaries.service.ts
├── user-dictionary-response.mapper.ts
└── user-dictionaries.module.ts
```
