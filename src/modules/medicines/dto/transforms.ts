import type { TransformFnParams } from 'class-transformer';

/**
 * 字符串去除首尾空格，非字符串原样返回交给校验器处理
 */
export function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * 可空文本：trim 后空字符串归一为 null
 */
export function trimToNull({ value }: TransformFnParams): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 字符串数组逐项去除首尾空格并去重，保持首次出现的顺序
 */
export function trimUniqueStrings({ value }: TransformFnParams): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return [
    ...new Set(
      value.map((item: unknown) =>
        typeof item === 'string' ? item.trim() : item,
      ),
    ),
  ];
}
