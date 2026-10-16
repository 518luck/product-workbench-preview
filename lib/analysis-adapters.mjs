import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digest } from './analysis-facts.mjs';
import { enrichNative, nativeConfiguration } from './analysis-native.mjs';

export const ANALYSIS_PROTOCOL = 2;
export const ADAPTER_VERSION = 1;
export const languageFor = (file) =>
  /\.pyi?$/.test(file)
    ? 'python'
    : /\.go$/.test(file)
      ? 'go'
      : /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(file)
        ? 'cpp'
        : /\.[cm]?[jt]sx?$/.test(file)
          ? 'javascript'
          : null;
const versions = { python: '0.25.0', go: '0.25.0', cpp: '0.23.4' };
const tools = {
  python: ['python3', ['--version']],
  go: ['go', ['version']],
  cpp: ['clang++', ['--version']],
};
const detected = new Map();
export function adapterProfiles() {
  const native = nativeConfiguration();
  const rulesHash = digest(
    [
      'analysis-index.mjs',
      'analysis-facts.mjs',
      'analysis-review.mjs',
      'analysis-foreign-worker.mjs',
      'analysis-native.mjs',
      'analysis-adapters.mjs',
      'analysis-session.mjs',
    ]
      .map((file) => fs.readFileSync(fileURLToPath(new URL('./' + file, import.meta.url))))
      .join(''),
  );
  const profiles = {
    javascript: {
      version: ADAPTER_VERSION,
      rulesHash,
      parser: 'typescript@6.0.2',
      syntax: true,
      calls: 'static-conservative',
      data: 'def-use',
      runtime: 'node-free-function-probes',
    },
  };
  for (const language of ['python', 'go', 'cpp']) {
    if (!detected.has(language)) {
      const [command, args] = tools[language];
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 100000,
      });
      detected.set(language, {
        command,
        available: !result.error && result.status === 0,
        version: (result.stdout || result.stderr || '').split('\n')[0].slice(0, 200),
      });
    }
    const grammar = fileURLToPath(new URL(`../assets/grammars/${language}.wasm`, import.meta.url));
    profiles[language] = {
      version: ADAPTER_VERSION,
      rulesHash,
      parser: `tree-sitter-${language}@${versions[language]}`,
      grammarHash: digest(fs.readFileSync(grammar)),
      syntax: true,
      calls: language === 'cpp' ? 'clang-or-runtime' : 'lexical-conservative',
      data: 'def-use-conservative',
      runtime: `${language}-free-scalar-probes`,
      tool: detected.get(language),
      native,
      semantic: {
        backend:
          language === 'python'
            ? 'python-ast-scope'
            : language === 'go'
              ? 'go-packages-ssa'
              : native.cppBinary
                ? 'clang-libtooling'
                : 'clang-frontend-compile-database',
        available:
          detected.get(language).available && (language !== 'go' || Boolean(native.goBinary)),
      },
      boundaries:
        language === 'python'
          ? [
              '装饰器、反射、动态导入及动态参数不能凭名称确认',
              '运行探针暂不支持异步、生成器及已有装饰器',
            ]
          : language === 'go'
            ? [
                'SSA 静态目标与接口动态分派分别报告',
                '运行探针限标量参数和单返回值自由函数、同包直接调用',
              ]
            : [
                '需要 arguments 形式的编译数据库；宏、虚调用及指针关系保留未知',
                native.cppBinary
                  ? 'LibTooling 使用当前编译数据库；未确认的宏和虚调用保留未知'
                  : 'LibTooling 尚未准备，AI 可执行 analysis prepare --language cpp；当前使用 Clang JSON 前端',
                '运行探针限无宏、非 constexpr 的标量自由函数',
              ],
    };
  }
  return profiles;
}
export function indexForeignSources(input) {
  const files = [...(input.foreignSources || [])].map(([absolute, text]) => ({
    file: path.relative(input.root, absolute).split(path.sep).join('/'),
    text,
    language: languageFor(absolute),
  }));
  if (!files.length)
    return {
      units: [],
      types: [],
      imports: [],
      gaps: [],
      facts: { values: [], edges: [], entries: [] },
    };
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./analysis-foreign-worker.mjs', import.meta.url))],
    {
      input: JSON.stringify({ root: input.root, files }),
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    return {
      units: [],
      types: [],
      imports: [],
      gaps: files.map(({ file }) => ({
        file,
        kind: 'adapter',
        message: `多语言解析失败：${result.error?.message || result.stderr.slice(0, 300)}`,
      })),
      facts: { values: [], edges: [], entries: [] },
    };
  return enrichNative(input, JSON.parse(result.stdout));
}
