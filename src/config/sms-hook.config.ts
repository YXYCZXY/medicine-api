import { Webhook } from 'standardwebhooks';

export const SMS_SECRET_NAMES = [
  'SEND_SMS_HOOK_SECRET',
  'ALIYUN_ACCESS_KEY_ID',
  'ALIYUN_ACCESS_KEY_SECRET',
  'ALIYUN_SMS_SIGN_NAME',
  'ALIYUN_SMS_TEMPLATE_CODE',
] as const;

export function smsConfigErrors(config: Record<string, unknown>): string[] {
  if (
    config.SMS_HOOK_ENABLED === undefined ||
    config.SMS_HOOK_ENABLED === '' ||
    config.SMS_HOOK_ENABLED === 'false'
  )
    return [];
  if (config.SMS_HOOK_ENABLED !== 'true')
    return ['SMS_HOOK_ENABLED 必须为 true 或 false'];
  const errors: string[] = [];
  for (const name of SMS_SECRET_NAMES) {
    const value = config[name];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      /[\r\n\0]/.test(value) ||
      value !== value.trim()
    )
      errors.push(`${name} 必填且不可包含首尾空白或控制字符`);
  }
  const secret = config.SEND_SMS_HOOK_SECRET;
  if (typeof secret === 'string') {
    try {
      if (
        !/^(?:v1,)?whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) ||
        Buffer.from(secret.replace(/^(?:v1,)?whsec_/, ''), 'base64').length < 32
      )
        throw new Error();
      new Webhook(secret.replace(/^v1,/, ''));
    } catch {
      errors.push('SEND_SMS_HOOK_SECRET 格式无效');
    }
  }
  return errors;
}
