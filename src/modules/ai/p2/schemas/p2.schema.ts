
import type { P1RouteResult } from '../../p1/p1-router.service.js';

/** P2 只能接受 P1 Router 明确放行的分支。 */
export type P2AllowedRoute = Extract<
  P1RouteResult,
  { action: 'CONTINUE_TO_P2' }
>;

/** 直接复用 P1 已校验的 Segment 结构，不在 P2 重定义。 */
export type P2SourceSegment =
  P2AllowedRoute['result']['segments'][number];

export interface P2DictionaryValues {
  categories: string[];
  efficacies: string[];
  symptoms: string[];
}

/** 空字典与读取失败必须明确区分。 */
export type P2DictionaryContext =
  | { status: 'available'; values: P2DictionaryValues }
  | { status: 'empty'; values: P2DictionaryValues }
  | {
      status: 'unavailable';
      reason: 'read_failed' | 'invalid_shape';
    };

/** 只能由后端构造，不能把客户端提供的白名单当作授权。 */
export interface P2Input {
  original_message: string;
  p1_route: P2AllowedRoute;
  request_context: {
    /** ISO 8601 时间字符串，由服务器提供。 */
    request_time: string;
    /** IANA 时区，如 Asia/Shanghai。 */
    timezone: string;
  };
  dictionary: P2DictionaryContext;
}

export type P2DictionaryKind =
  | 'category'
  | 'efficacy'
  | 'symptom';

export type P2DictionaryRelation =
  | 'exact'
  | 'alias'
  | 'group_member'
  | 'semantic_candidate';

/**
 * dictionary_value 必须是当前用户已加载字典中的真实值。
 * 候选关联不能证明存在药品、就诊记录或某项症状。
 */
export interface P2DictionaryCandidate {
  kind: P2DictionaryKind;
  dictionary_value: string;
  matched_concept: string;
  source_text: string;
  relation: P2DictionaryRelation;
}

export type P2IntentState = 'ready' | 'needs_clarification';

export type P2MissingReason =
  | 'required'
  | 'ambiguous'
  | 'unresolved_reference'
  | 'unresolved_time';

export interface P2MissingField {
  field: string;
  reason: P2MissingReason;
}

/**
 * start/end 仅在可以可靠解析时填写，不能猜测时间。
 * 真实时间比较、时区换算在后续执行阶段校验。
 */
export interface P2TimeRange {
  raw_text: string;
  start?: string;
  end?: string;
}

/** 仅描述用户提到的记录，不能视为已定位到真实数据库记录。 */
export interface P2RecordSelector {
  record_id?: string;
  name?: string;
  reference_text?: string;
}

/**
 * 写入意图的过渡性语义字段，不是 Prisma 字段或现有 DTO。
 * 后续必须核对业务 DTO 并由 Validator 严格验证映射。
 */
export interface P2CapturedField {
  field_name: string;
  raw_value: string;
}

export interface P2ConsultParameters {
  symptoms: string[];
  medicine_names: string[];
  keywords: string[];
}

export type P2MedicineQueryFocus =
  | 'list'
  | 'inventory_quantity'
  | 'record_details'
  | 'related_records';

export interface P2MedicineSearchParameters {
  medicine_names: string[];
  query_focus: P2MedicineQueryFocus;
  keywords: string[];
}

export interface P2VisitSearchParameters {
  symptom_keywords: string[];
  keywords: string[];
  time_range?: P2TimeRange;
  limit?: number;
  order?: 'recent_first' | 'oldest_first';
}

export interface P2ReminderSearchParameters {
  keywords: string[];
  time_range?: P2TimeRange;
}

/** 新增记录：只捕获用户明确说出的字段。 */
export interface P2CreateParameters {
  fields: P2CapturedField[];
}

/** 更新记录：定位目标与要修改的字段分离。 */
export interface P2UpdateParameters {
  selector: P2RecordSelector;
  fields: P2CapturedField[];
}

/** 删除记录：仅捕获目标，不意味着已授权执行删除。 */
export interface P2DeleteParameters {
  selector: P2RecordSelector;
}

/** 13 种意图与参数的唯一对应关系。 */
export interface P2IntentParametersMap {
  'medical.consult': P2ConsultParameters;

  'medicine.search': P2MedicineSearchParameters;
  'medicine.create': P2CreateParameters;
  'medicine.update': P2UpdateParameters;
  'medicine.delete': P2DeleteParameters;

  'visit.search': P2VisitSearchParameters;
  'visit.create': P2CreateParameters;
  'visit.update': P2UpdateParameters;
  'visit.delete': P2DeleteParameters;

  'reminder.search': P2ReminderSearchParameters;
  'reminder.create': P2CreateParameters;
  'reminder.update': P2UpdateParameters;
  'reminder.delete': P2DeleteParameters;
}

export type P2IntentType = keyof P2IntentParametersMap;

export interface P2IntentBase<
  TType extends P2IntentType,
  TParameters,
> {
  intent_id: string;
  type: TType;
  /** 必须属于 P1 Router 的 allowedSegmentIds。 */
  source_segment_ids: string[];
  /** ready 表示提取完成，不代表可以自动执行写操作。 */
  state: P2IntentState;
  parameters: TParameters;
  dictionary_candidates: P2DictionaryCandidate[];
  missing_fields: P2MissingField[];
}

/** 映射类型生成真正的判别联合，按 type 自动收窄 parameters。 */
export type P2Intent = {
  [TType in P2IntentType]: P2IntentBase<
    TType,
    P2IntentParametersMap[TType]
  >;
}[P2IntentType];

export type P2OverallStatus =
  | 'ready'
  | 'partial'
  | 'needs_clarification';

export interface P2Clarification {
  intent_id: string;
  field: string;
  reason: P2MissingReason;
}

export interface P2UnresolvedSegment {
  segment_id: string;
  reason: 'unsupported_intent' | 'insufficient_information';
}

export interface P2Result {
  stage: 'P2';
  status: P2OverallStatus;
  /** 直接来自 P1 Router，不由 P2 模型自行修改。 */
  safety_notice_required: boolean;
  dictionary_status: P2DictionaryContext['status'];
  intents: P2Intent[];
  clarifications: P2Clarification[];
  unresolved_segments: P2UnresolvedSegment[];
}

export type P2FallbackReason =
  | 'INVALID_P1_SOURCE'
  | 'DICTIONARY_CONTEXT_INVALID'
  | 'MODEL_FAILED'
  | 'MODEL_OUTPUT_INVALID'
  | 'P2_VALIDATION_FAILED';

/** 仅描述校验规则，不携带用户内容或模型字段值。 */
export type P2ValidationFailureCategory =
  | 'INVALID_TOP_LEVEL'
  | 'INVALID_REQUEST_CONTEXT'
  | 'INVALID_INTENT_SHAPE'
  | 'INVALID_INTENT_TYPE'
  | 'INVALID_SEGMENT_REFERENCE'
  | 'INVALID_SEGMENT_COVERAGE'
  | 'INVALID_STATE'
  | 'INVALID_DICTIONARY_CANDIDATE_SHAPE'
  | 'INVALID_DICTIONARY_CANDIDATE_NOT_PERMITTED'
  | 'INVALID_DICTIONARY_CANDIDATE_DUPLICATE'
  | 'INVALID_INTENT_PARAMETERS'
  | 'INVALID_UNRESOLVED_SEGMENT'
  | 'UNEXPECTED';

export type P2ProcessResult =
  | { action: 'OK'; result: P2Result }
  | {
      action: 'SAFE_FALLBACK';
      reason: P2FallbackReason;
      category?: P2ValidationFailureCategory;
    };
