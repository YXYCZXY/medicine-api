import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

const FIELD_LABELS: Record<string, string> = {
  name: '药品名称',
  categoryId: '药品分类',
  quantity: '库存数量',
  unit: '单位',
  expirationDate: '有效期',
  dosePerTime: '单次剂量',
  timesPerDay: '每日次数',
  efficacyTags: '功效标签',
  medicationTimings: '用药时段',
  locationId: '存放位置',
  note: '备注',
};

type MessageBuilder = (label: string, error: ValidationError) => string;

/**
 * 按优先级排列：同一字段多个规则失败时，只返回最先命中的一条
 */
const CONSTRAINT_MESSAGES: [string, MessageBuilder][] = [
  ['whitelistValidation', (_, error) => `不支持的字段：${error.property}`],
  ['isNotEmpty', (label) => `${label}不能为空`],
  ['isString', (label) => `${label}必须是文本`],
  ['isInt', (label) => `${label}必须是整数`],
  ['isNumber', (label) => `${label}必须是数字，且最多保留 2 位小数`],
  ['isArray', (label) => `${label}必须是数组`],
  ['isUUID', (label) => `${label}格式不正确`],
  ['isDateString', (label) => `${label}格式应为 YYYY-MM-DD`],
  ['isPositive', (label) => `${label}必须大于 0`],
  ['min', (label) => `${label}超出允许范围`],
  ['max', (label) => `${label}超出允许范围`],
  ['maxLength', (label) => `${label}长度超出限制`],
  ['arrayMaxSize', (label) => `${label}数量超出限制`],
  ['matches', (label) => `${label}格式不正确`],
];

function toMessage(error: ValidationError): string | undefined {
  const constraints = error.constraints;

  if (!constraints) {
    const child = error.children?.find((item) => item.constraints);
    return child ? toMessage(child) : undefined;
  }

  const label = FIELD_LABELS[error.property] ?? error.property;
  const matched = CONSTRAINT_MESSAGES.find(([key]) => key in constraints);

  return matched ? matched[1](label, error) : `${label}格式不正确`;
}

/**
 * 将 class-validator 错误转换为单条可直接展示的中文提示
 */
export function createValidationException(
  errors: ValidationError[],
): BadRequestException {
  const message =
    errors.map(toMessage).find((item) => item !== undefined) ??
    '请求参数不正确';

  return new BadRequestException(message);
}
