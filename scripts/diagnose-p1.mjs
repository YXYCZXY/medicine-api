
import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ============================================================
// 1. 测试配置
// ============================================================

const TEST_MESSAGE = '我的布洛芬还有多少？';

const OLLAMA_BASE_URL =
  'http://127.0.0.1:11434';

const OLLAMA_MODEL =
  'hf.co/lmstudio-community/Qwen2.5-7B-Instruct-1M-GGUF:Q4_K_M';

// ============================================================
// 2. 加载编译后的 NestJS 服务
// ============================================================

function findCompiledFile(relativePath) {
  const candidates = [
    resolve('dist', relativePath),
    resolve('dist', 'src', relativePath),
  ];

  const found = candidates.find(existsSync);

  if (!found) {
    throw new Error(
      `找不到编译文件：${relativePath}。请先运行 npx tsc -p tsconfig.json`,
    );
  }

  return found;
}

async function loadModule(relativePath) {
  const filePath = findCompiledFile(relativePath);

  return import(pathToFileURL(filePath).href);
}

// ============================================================
// 3. 执行诊断
// ============================================================

let currentStage = '加载模块';

try {
  const [
    { OllamaService },
    { P1ParserService },
    { P1ValidatorService },
    { P1SafetyGuardService },
    { P1RouterService },
  ] = await Promise.all([
    loadModule('modules/ai/llm/ollama.service.js'),
    loadModule('modules/ai/p1/p1-parser.service.js'),
    loadModule('modules/ai/p1/p1-validator.service.js'),
    loadModule('modules/ai/p1/p1-safety-guard.service.js'),
    loadModule('modules/ai/p1/p1-router.service.js'),
  ]);

  // 使用与现有 .env 相同的配置
  const configService = {
    get(key) {
      if (key === 'OLLAMA_BASE_URL') {
        return OLLAMA_BASE_URL;
      }

      if (key === 'OLLAMA_MODEL') {
        return OLLAMA_MODEL;
      }

      return undefined;
    },
  };

  const ollama = new OllamaService(configService);

  // 包装模型调用，仅用于本地诊断
  const originalGenerate =
    ollama.generate.bind(ollama);

  ollama.generate = async (request) => {
    console.log('\n[1] 开始调用真实 Ollama...');
    console.log('模型:', OLLAMA_MODEL);
    console.log('输出格式:', request.responseFormat);

    const startTime = Date.now();

    const response = await originalGenerate(request);

    console.log(
      '模型调用耗时:',
      Date.now() - startTime,
      'ms',
    );

    console.log('\n[2] 模型原始输出：');
    console.log(response.content);

    return response;
  };

  const parser = new P1ParserService(ollama);

  const validator = new P1ValidatorService();

  const safetyGuard =
    new P1SafetyGuardService(validator);

  const router = new P1RouterService(validator);

  // ----------------------------------------------------------
  // Parser
  // ----------------------------------------------------------

  currentStage = 'P1 Parser / Ollama';

  const parsed = await parser.classify(TEST_MESSAGE);

  console.log('\n✓ Parser 成功解析 JSON');

  // ----------------------------------------------------------
  // Validator
  // ----------------------------------------------------------

  currentStage = 'P1 Validator';

  const validated = validator.validate(parsed);

  console.log('✓ Validator 校验通过');

  // ----------------------------------------------------------
  // Safety Guard
  // ----------------------------------------------------------

  currentStage = 'P1 Safety Guard';

  const safe = safetyGuard.evaluate(
    TEST_MESSAGE,
    validated,
  );

  console.log('✓ Safety Guard 校验通过');

  // ----------------------------------------------------------
  // Router
  // ----------------------------------------------------------

  currentStage = 'P1 Router';

  const result = router.route(safe);

  console.log('\n[3] Router 最终结果：');

  console.log(JSON.stringify(result, null, 2));

  console.log('\n诊断完成。');
} catch (error) {
  console.error('\n========== 诊断失败 ==========');

  console.error('失败阶段:', currentStage);

  console.error(
    '异常类型:',
    error?.name ?? 'UnknownError',
  );

  console.error(
    '错误代码:',
    error?.code ?? '无',
  );

  console.error(
    '错误信息:',
    error?.message ?? String(error),
  );

  console.error('================================');

  process.exitCode = 1;
}
