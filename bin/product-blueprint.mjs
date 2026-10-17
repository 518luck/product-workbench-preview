#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDocument,
  renderDocument,
  schemaPath,
  templatePath,
  validateDocument,
} from '../lib/document.mjs';
import {
  applyChanges,
  getFeature,
  listFeatures,
  queryDocument,
  readSnapshot,
  renderSnapshot,
} from '../lib/document-operations.mjs';
import { createDocumentServer } from '../lib/document-server.mjs';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const changesSchemaPath = fileURLToPath(new URL('../schema/changes.schema.json', import.meta.url));
const analysisSchemaPath = fileURLToPath(
  new URL('../schema/analysis.schema.json', import.meta.url),
);
const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
const argv = process.argv.slice(2);
let command = 'help';
let options = { json: argv.includes('--json') };

const commands = {
  init: {
    options: ['name'],
    usage: 'init [目录] --name 产品名称',
    description: '创建空文档及 HTML；已有文件不会被覆盖。',
  },
  validate: {
    options: ['document'],
    usage: 'validate [目录或文档.json]',
    description: '检查文档结构、引用、版本和完成记录。',
  },
  render: {
    options: ['document', 'output'],
    usage: 'render [目录或文档.json] [--output 文件.html]',
    description: '使用固定模板生成 HTML；生成失败保留原 HTML。',
  },
  serve: {
    options: ['document', 'port'],
    usage: 'serve [目录或文档.json] [--port 端口]',
    description: '启动仅监听本机的阅读与编辑服务；默认端口为 62039。',
  },
  schema: {
    options: [
      'changes',
      'analysis',
      'delivery',
      'verification',
      'flow',
      'verification-plan',
      'assessment',
    ],
    usage:
      'schema [--changes | --analysis | --delivery | --verification | --flow | --verification-plan | --assessment]',
    description: '输出文档、整批变更或分析记录与流程依据规范。',
  },
  'document status': {
    options: ['document'],
    usage: 'document status [目录或文档.json]',
    description: '比较当前源码与功能验收快照，列出新增、修改、删除文件；不修改蓝图或执行代码。',
  },
  'document check': {
    options: ['document', 'analysis-session', 'input'],
    usage: 'document check [目录或文档.json] --analysis-session 会话 --input 交付审阅.json|-',
    description:
      '只读检查分析、业务范围、分层验收、图表及最新 HTML；delivery v4 按预先保存的方案核验，v3 保留严格流程检查。',
  },
  'verification plan': {
    options: ['document', 'analysis-session', 'input'],
    usage: 'verification plan [产品书] --analysis-session 会话 [--input 验收方案.json|-]',
    description:
      '执行前保存逐业务步骤的源码、组件、契约或端到端验收范围；省略 input 只读查询已有方案。',
  },
  'verification run': {
    options: ['document', 'analysis-session', 'input'],
    usage:
      'verification run <功能编号> [目录或文档.json] --analysis-session 会话 --input 命令.json|-',
    description:
      '显式执行 {command,args,timeoutMs?} 验收命令并记录结果；不经过 shell，不修改产品文档。',
  },
  'document get': {
    options: ['document', 'section'],
    usage: 'document get [目录或文档.json] [--section all|product|dependencies|diagrams]',
    description: '读取文档分区及当前文档哈希；默认读取 all。',
  },
  'feature list': {
    options: ['document', 'group', 'status'],
    usage: 'feature list [目录或文档.json] [--group 模块/子模块] [--status draft|complete|unknown]',
    description: '列出功能摘要；按分组前缀和草稿／完成筛选。',
  },
  'feature get': {
    options: ['document', 'related'],
    usage: 'feature get <功能编号> [目录或文档.json] [--related]',
    description: '读取完整功能及文档哈希；--related 附带关联依赖。',
  },
  'feature create': {
    options: ['input', 'expected-hash'],
    usage: 'feature create <功能编号> [目录或文档.json] --input 文件|- --expected-hash 哈希',
    description: '输入功能数据，新增草稿；版本由工具维护。',
  },
  'feature update': {
    options: ['input', 'expected-hash'],
    usage: 'feature update <功能编号> [目录或文档.json] --input 文件|- --expected-hash 哈希',
    description: '输入需修改的字段；保留未指定内容，禁止普通修改改写定义原文。',
  },
  'feature define': {
    options: ['input', 'expected-hash'],
    usage: 'feature define <功能编号> [目录或文档.json] --input 文件|- --expected-hash 哈希',
    description: '明确改写定义原文，输入 {"description":"新的定义"}。',
  },
  'feature delete': {
    options: ['expected-hash'],
    usage: 'feature delete <功能编号> [目录或文档.json] --expected-hash 哈希',
    description: '明确删除功能；仍有引用时拒绝保存，需通过 apply 一起清理关联。',
  },
  'feature sync': {
    options: ['expected-hash'],
    usage: 'feature sync <功能编号> [目录或文档.json] --expected-hash 哈希',
    description: '声明业务流程已与当前定义同步；不生成或改写流程内容。',
  },
  'feature complete': {
    options: ['input', 'expected-hash'],
    usage: 'feature complete <功能编号> [目录或文档.json] --input 文件|- --expected-hash 哈希',
    description:
      '输入 {"revision":版本,"implementation":验收记录}；--require-verification 核对 verification run 执行编号，可带 resolvedAnnotationIds 清理已处理批注。',
  },
  'feature assess': {
    options: ['input', 'document', 'analysis-session', 'dry-run', 'no-render'],
    usage: 'feature assess <功能编号> [产品书] --analysis-session 会话 --input 核对.json|-',
    description:
      '逐项对照功能定义与实际实现；全部实现为完成，有具体未实现项为草稿，无法判断为待确认。不会生成测试通过记录或删除批注。',
  },
  'verification diagnose': {
    options: ['input', 'document', 'analysis-session'],
    usage: 'verification diagnose <功能编号> [产品书] --analysis-session 会话 --input 诊断.json|-',
    description:
      '工具直接检查命令可用性、文件存在或 TCP 连接；输入见 schema --verification 的 $defs.environmentDiagnostic。诊断不作为业务通过证据。',
  },
  apply: {
    options: ['input'],
    usage: 'apply [目录或文档.json] --input 文件|-',
    description:
      '提交 {"version":1,"expectedHash":"读取时的哈希","operations":[...]}，全部校验通过后一起保存。',
  },
  'flow record': {
    options: ['document', 'session', 'input'],
    usage: 'flow record [产品书] --session 会话 --input 映射.json|-',
    description: '按当前源码事实绑定业务步骤、调用、数据及正常／异常场景。',
  },
  'flow list': {
    options: ['document', 'session'],
    usage: 'flow list [产品书] --session 会话',
    description: '读取当前产品书保存的流程映射与证据绑定。',
  },
  'flow sync': {
    options: ['document', 'session'],
    usage: 'flow sync [产品书] --session 会话',
    description: '保存工具计算的流程状态及缺口并更新 HTML；保留定义、批注和完成历史。',
  },
  'flow check': {
    options: ['document', 'session', 'id'],
    usage: 'flow check [产品书] --session 会话 [--id 流程编号]',
    description: '检查入口覆盖、步骤衔接、数据来源和真实运行观测；不执行项目代码。',
  },
  'analysis prepare': {
    options: ['language'],
    usage: 'analysis prepare --language go|cpp',
    description:
      '由 AI 显式准备可选 Go packages/SSA 或 Clang LibTooling 分析工具；固定依赖，失败保留能力缺口。',
  },
  'analysis capabilities': {
    options: [],
    usage: 'analysis capabilities',
    description: '读取语言解析、语义工具和探针的实际能力边界。',
  },
  'analysis scan': {
    options: ['config'],
    usage: 'analysis scan [项目目录] [--config 范围.json]',
    description:
      '索引 JS／TS（含 JSX／TSX），创建或恢复相同源码快照；配置为 include/exclude 相对路径或 glob 数组。',
  },
  'analysis list': {
    options: ['session', 'offset', 'limit', 'status', 'kind'],
    usage:
      'analysis list --session 会话 [--kind units|contexts|files|types|traces|entries|values|edges] [--status all|pending|recorded] [--offset 0] [--limit 50]',
    description: '分页读取分析清单；默认每页 50 项，最大 200 项。',
  },
  'analysis read': {
    options: ['session', 'offset', 'length', 'input'],
    usage:
      'analysis read [单元编号] --session 会话 [--offset 0] [--length 16000] [--input 读取批次.json|-]',
    description:
      '读取源码并生成工具凭据；可用 reads 批次一次读取 1–32 项，批次原子保存。位置使用 UTF-16，单项最大 100000。',
  },
  'analysis record': {
    options: ['session', 'input'],
    usage: 'analysis record --session 会话 --input 记录.json|-',
    description:
      '逐项保存函数分析；须完整读取并解释每个 reviewPoint，字段规范见 schema --analysis。',
  },
  'analysis trace': {
    options: ['session', 'input'],
    usage: 'analysis trace --session 会话 --input 依据.json|-',
    description: '绑定最终业务字段指纹与源码记录／需求依据；变更后须更新对应依据。',
  },
  'analysis check': {
    options: ['session'],
    usage: 'analysis check --session 会话',
    description:
      '核验源码新鲜度、读取覆盖、记录、上下文和依据，输出具体缺项；不完整返回非零退出码。',
  },
};
const mutationOptions = [
  'document',
  'dry-run',
  'no-render',
  'output',
  'analysis-session',
  'allow-partial-analysis',
  'require-verification',
];
const booleanOptions = new Set([
  'json',
  'help',
  'version',
  'changes',
  'related',
  'dry-run',
  'no-render',
  'analysis',
  'delivery',
  'verification',
  'verification-plan',
  'assessment',
  'flow',
  'allow-partial-analysis',
  'require-verification',
]);
const valueOptions = new Set([
  'name',
  'document',
  'output',
  'port',
  'section',
  'group',
  'status',
  'input',
  'expected-hash',
  'session',
  'analysis-session',
  'config',
  'offset',
  'limit',
  'length',
  'kind',
  'id',
  'language',
]);
const mutations = new Set(['create', 'update', 'define', 'delete', 'sync', 'complete']);

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}
function emit(value, message) {
  console.log(options.json ? JSON.stringify(value, null, 2) : message);
}
function errorCode(error) {
  if (
    error.code === 'INVALID_ARGUMENT' ||
    error.code === 'CONFLICT' ||
    error.code === 'RENDER_FAILED' ||
    error.code === 'VALIDATION_FAILED' ||
    error.code === 'ENVIRONMENT_UNAVAILABLE'
  )
    return error.code;
  if (error.status === 409) return 'CONFLICT';
  if (error.report) return 'VALIDATION_FAILED';
  return error.code?.startsWith('E') ? 'IO_ERROR' : error.code || 'INTERNAL_ERROR';
}
function fail(error) {
  const code = errorCode(error);
  const result = {
    command,
    valid: false,
    code,
    error: error.message,
    ...(error.report ? { errors: error.report.errors } : {}),
  };
  for (const field of [
    'status',
    'details',
    'expectedHash',
    'actualHash',
    'documentSaved',
    'htmlUpdated',
    'result',
  ]) {
    if (error[field] !== undefined) result[field] = error[field];
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    const details = error.report?.errors ?? (Array.isArray(error.details) ? error.details : []);
    console.error(
      [error.message, ...details.map((item) => `${item.path}：${item.message}`)].join('\n'),
    );
  }
  process.exitCode =
    code === 'INVALID_ARGUMENT'
      ? 2
      : code === 'CONFLICT' || code === 'ANALYSIS_STALE'
        ? 3
        : code === 'RENDER_FAILED' && error.documentSaved
          ? 4
          : 1;
}
function parseArguments() {
  const parsed = {},
    positional = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!positionalOnly && token === '--') {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const normalized = token === '-h' ? '--help' : token;
    if (!normalized.startsWith('--')) invalid(`不支持的选项：${token}`);
    const equals = normalized.indexOf('=');
    const key = normalized.slice(2, equals === -1 ? undefined : equals);
    if (!booleanOptions.has(key) && !valueOptions.has(key)) invalid(`不支持的选项：${token}`);
    if (Object.hasOwn(parsed, key)) invalid(`选项不能重复：--${key}`);
    if (booleanOptions.has(key)) {
      if (equals !== -1) invalid(`--${key} 不接受参数。`);
      parsed[key] = true;
    } else {
      const value = equals === -1 ? argv[++index] : normalized.slice(equals + 1);
      if (!value || (value.startsWith('-') && !(key === 'input' && value === '-')))
        invalid(`--${key} 缺少参数。`);
      parsed[key] = value;
    }
  }
  options = parsed;
  if (positional[0] === 'help') {
    options.help = true;
    positional.shift();
  }
  if (options.version || positional[0] === 'version') {
    if (positional[0] === 'version') positional.shift();
    if (positional.length || Object.keys(options).some((key) => !['version', 'json'].includes(key)))
      invalid('--version 只接受可选的 --json。');
    command = 'version';
    return [];
  }
  if (!positional.length) {
    if (Object.keys(options).some((key) => !['help', 'json'].includes(key)))
      invalid('请先指定命令。');
    command = 'help';
    return [];
  }
  const top = positional.shift();
  command = ['feature', 'document', 'analysis', 'verification', 'flow'].includes(top)
    ? `${top}${positional[0] ? ` ${positional.shift()}` : ''}`
    : top;
  if (
    ['feature', 'document', 'analysis', 'verification', 'flow'].includes(command) &&
    options.help
  ) {
    for (const key of Object.keys(options))
      if (!['help', 'json'].includes(key)) invalid(`${command} 帮助不支持选项：--${key}`);
    return positional;
  }
  if (!commands[command]) invalid(`未知命令：${command}。使用 --help 查看命令。`);
  const allowed = new Set([
    'help',
    'json',
    ...commands[command].options,
    ...(isMutation() ? mutationOptions : []),
  ]);
  for (const key of Object.keys(options))
    if (!allowed.has(key)) invalid(`${command} 不支持选项：--${key}`);
  if (options['no-render'] && options.output) invalid('--no-render 不能与 --output 同时使用。');
  if (options['allow-partial-analysis'] && !options['analysis-session'])
    invalid('--allow-partial-analysis 需要 --analysis-session。');
  if (
    [
      'changes',
      'analysis',
      'delivery',
      'verification',
      'flow',
      'verification-plan',
      'assessment',
    ].filter((key) => options[key]).length > 1
  )
    invalid('schema 格式选项不能同时使用。');
  return positional;
}
function isMutation() {
  return (
    command === 'apply' || (command.startsWith('feature ') && mutations.has(command.split(' ')[1]))
  );
}
function checkPositionals(positional) {
  const hasId =
    (command.startsWith('feature ') && command !== 'feature list') ||
    ['verification run', 'verification diagnose'].includes(command);
  const maximum = hasId
    ? 2
    : (command.startsWith('analysis ') && !['analysis scan', 'analysis read'].includes(command)) ||
        command === 'schema' ||
        ['feature', 'document', 'analysis', 'verification', 'help'].includes(command)
      ? 0
      : 1;
  if (positional.length > maximum) invalid('包含多余的位置参数，请查看当前命令的 --help。');
  if (options.document && positional.length > (hasId ? 1 : 0))
    invalid('--document 不能与位置文档路径同时使用。');
}
function helpText() {
  const global = '可使用 --json 获取结构化结果，使用 --help 查看当前命令帮助。';
  if (commands[command]) {
    const detail = commands[command];
    return `产品蓝图 CLI ${version}\n\n  ${detail.usage}\n\n${detail.description}\n${isMutation() ? '写入支持 --dry-run（只预览）、--no-render（仅保存文档）、--output 文件.html。\n' : ''}${detail.options.includes('document') || isMutation() ? '可用 --document 指定文档，不能与位置文档路径同时使用。\n' : ''}${global}\n`;
  }
  const entries = Object.entries(commands).filter(
    ([key]) =>
      !['feature', 'document', 'analysis', 'verification', 'flow'].includes(command) ||
      key.startsWith(`${command} `),
  );
  return `产品蓝图 CLI ${version}\n\n${entries.map(([, detail]) => `  ${detail.usage}`).join('\n')}\n\n默认文档为当前目录的 product-document.json，默认 HTML 为同目录的 index.html。\nAI 在外部梳理业务、实现及验证；CLI 负责文档维护，不调用 AI。\n${global}\n  --version  查看版本\n`;
}
function documentFile(positional) {
  if (positional.length > 1) invalid('每次仅接受一个目录或文档路径。');
  if (options.document && positional.length) invalid('--document 不能与位置文档路径同时使用。');
  const resolved = path.resolve(options.document || positional[0] || '.');
  return resolved.endsWith('.json') ? resolved : path.join(resolved, 'product-document.json');
}
function inputObject() {
  if (!options.input) invalid('需要 --input 文件路径，或 --input - 从标准输入读取。');
  let data;
  try {
    data = JSON.parse(
      fs.readFileSync(options.input === '-' ? 0 : path.resolve(options.input), 'utf8'),
    );
  } catch (error) {
    if (error instanceof SyntaxError) invalid('输入内容不是有效的 JSON。');
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('输入必须是 JSON 对象。');
  return data;
}
function inputFields(data, allowed) {
  const unknown = Object.keys(data).filter((key) => !allowed.includes(key));
  if (unknown.length) invalid(`输入包含不支持的字段：${unknown.join('、')}`);
}
function mutationMessage(result) {
  const action = result.dryRun
    ? '变更预览（未保存）'
    : result.changed
      ? '文档已保存'
      : '文档内容未变化';
  const lines = [action, `文档哈希：${result.documentHash}`];
  const state = (value, absent) =>
    value
      ? { complete: '完成', draft: '草稿', unknown: '待确认' }[value.status] || '待确认'
      : absent;
  for (const feature of result.features || []) {
    lines.push(
      `${feature.id}：${state(feature.before, '不存在')} → ${state(feature.after, '已删除')}，版本 ${feature.before?.revision ?? '-'} → ${feature.after?.revision ?? '-'}`,
    );
  }
  for (const change of result.changes || [])
    lines.push(
      `${change.path}：${JSON.stringify(change.before) ?? '不存在'} → ${JSON.stringify(change.after) ?? '已删除'}`,
    );
  for (const deletion of result.deletions || [])
    lines.push(`删除 ${deletion.type} ${deletion.id}；${deletion.references?.length || 0} 项关联`);
  if (result.htmlUpdated) lines.push(`HTML：${result.html}`);
  if (result.analysis) {
    lines.push(
      result.analysis.independentCompletion
        ? '本次功能依据与真实验收成立；其他源码能力缺口保留：'
        : result.analysis.partial
          ? '分析未完整，仅保存草稿；具体缺口：'
          : '分析与字段依据检查通过。',
    );
    for (const gap of result.analysis.gaps)
      lines.push(`${gap.path || gap.file || gap.kind}：${gap.message}`);
  }
  return lines.join('\n');
}
async function initialize(positional) {
  if (positional.length > 1) invalid('init 每次仅接受一个目录。');
  const directory = path.resolve(positional[0] || '.');
  const filename = path.join(directory, 'product-document.json');
  const output = path.join(directory, 'index.html');
  if (fs.existsSync(filename) || fs.existsSync(output))
    throw new Error('目录中已有文档或 HTML，初始化不会覆盖它们。');
  const name = (options.name || path.basename(directory)).trim();
  if (!name) invalid('产品名称不能为空。');
  const document = {
    schemaVersion: 1,
    product: { name, background: '', actors: [] },
    features: {},
    dependencies: [],
    diagrams: {},
  };
  const html = renderDocument(document);
  fs.mkdirSync(directory, { recursive: true });
  const created = [];
  try {
    for (const [target, contents] of [
      [output, html],
      [filename, JSON.stringify(document, null, 2) + '\n'],
    ]) {
      const descriptor = fs.openSync(target, 'wx');
      created.push(target);
      try {
        fs.writeFileSync(descriptor, contents);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  } catch (error) {
    for (const target of created) fs.unlinkSync(target);
    if (error.code === 'EEXIST') throw new Error('目录中已有文档或 HTML，初始化不会覆盖它们。');
    throw error;
  }
  emit(
    { command, document: filename, html: output },
    `已创建产品蓝图：${filename}\nHTML：${output}`,
  );
}

try {
  const positional = parseArguments();
  checkPositionals(positional);
  if (command === 'version') emit({ command, version }, version);
  else if (command === 'help' || options.help) {
    if (
      ['feature', 'document', 'analysis', 'verification', 'flow'].includes(command) &&
      positional.length
    )
      invalid('帮助命令包含多余的位置参数。');
    const help = helpText();
    emit({ command, help }, help);
  } else if (command === 'schema') {
    if (positional.length) invalid('schema 不接受文档路径。');
    console.log(
      fs
        .readFileSync(
          options.assessment
            ? new URL('../schema/implementation-assessment.schema.json', import.meta.url)
            : options['verification-plan']
              ? new URL('../schema/verification-plan.schema.json', import.meta.url)
              : options.flow
                ? new URL('../schema/flow.schema.json', import.meta.url)
                : options.delivery
                  ? new URL('../schema/delivery.schema.json', import.meta.url)
                  : options.verification
                    ? new URL('../schema/verification.schema.json', import.meta.url)
                    : options.analysis
                      ? analysisSchemaPath
                      : options.changes
                        ? changesSchemaPath
                        : schemaPath,
          'utf8',
        )
        .trim(),
    );
  } else if (command === 'feature assess') {
    if (!options['analysis-session']) invalid('实现核对需要 --analysis-session。');
    const id = positional.shift();
    if (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) invalid('请提供有效功能编号。');
    const { assessImplementation } = await import('../lib/implementation-assessment.mjs');
    const result = await assessImplementation(
      documentFile(positional),
      id,
      options['analysis-session'],
      inputObject(),
      {
        dryRun: Boolean(options['dry-run']),
        render: !options['no-render'],
      },
    );
    emit({ command, ...result }, JSON.stringify(result, null, 2));
  } else if (command === 'init') await initialize(positional);
  else if (command.startsWith('flow ')) {
    if (!options.session) invalid('流程命令需要 --session。');
    const flow = await import('../lib/flow.mjs');
    const filename = documentFile(positional);
    let result;
    if (command === 'flow record')
      result = await flow.recordFlows(filename, options.session, inputObject());
    if (command === 'flow sync') {
      const { syncFlowStatus } = await import('../lib/flow-status.mjs');
      result = await syncFlowStatus(filename, options.session);
    }
    if (command === 'flow check')
      result = flow.checkFlows(filename, options.session, { id: options.id });
    if (command === 'flow list') {
      const { loadSession } = await import('../lib/analysis-session.mjs');
      const { state } = loadSession(options.session);
      result = {
        flows: Object.values(state.flows || {}).filter(
          (record) => record.documentPath === fs.realpathSync(filename),
        ),
        dispositions: state.entryDispositions || {},
      };
    }
    emit({ command, ...result }, JSON.stringify(result, null, 2));
    if (result.valid === false) process.exitCode = 1;
  } else if (command === 'analysis prepare') {
    const { prepareLanguage } = await import('../lib/analysis-native.mjs');
    const result = prepareLanguage(options.language);
    emit({ command, ...result }, JSON.stringify(result, null, 2));
  } else if (command === 'analysis capabilities') {
    const { adapterProfiles } = await import('../lib/analysis-adapters.mjs');
    const { workflowHostObservation } = await import('../lib/component-observation.mjs');
    const result = {
      protocol: 2,
      languages: adapterProfiles(),
      runtime: {
        component: '工具探针核对声明的具体结果，不等于整条业务链路观测',
        observationBinding: 'step-and-criterion',
        resultScope: 'distinct-source-location-per-step',
        failureBinding: 'rejection-or-same-invocation-branch',
        verificationPlan: 3,
        resultFields: 'javascript-own-data-properties',
        commandIsolation: 'temporary-project-copy',
        workflowHostObservation,
      },
      scope: '已识别入口、声明场景及所列能力范围；未知关系必须保留缺口。',
    };
    emit({ command, ...result }, JSON.stringify(result, null, 2));
  } else if (command === 'verification plan') {
    if (!options['analysis-session']) invalid('验收方案需要 --analysis-session。');
    const filename = documentFile(positional);
    const plan = await import('../lib/verification-plan.mjs');
    let result;
    if (options.input)
      result = await plan.saveVerificationPlan(
        filename,
        options['analysis-session'],
        inputObject(),
      );
    else {
      const { loadSession } = await import('../lib/analysis-session.mjs');
      const { state } = loadSession(options['analysis-session']);
      result = {
        plans: Object.values(state.verificationPlans || {}).filter(
          (p) => p.documentPath === fs.realpathSync(filename),
        ),
        report: plan.checkVerificationPlans(filename, options['analysis-session'], state),
      };
    }
    emit({ command, ...result }, JSON.stringify(result, null, 2));
  } else if (command === 'verification run' || command === 'verification diagnose') {
    if (!options['analysis-session']) invalid('验收需要 --analysis-session。');
    const id = positional.shift();
    if (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) invalid('请提供有效功能编号。');
    const verification = await import('../lib/verification.mjs');
    const result = await (
      command === 'verification diagnose'
        ? verification.runEnvironmentDiagnostic
        : verification.runVerification
    )(documentFile(positional), id, options['analysis-session'], inputObject());
    emit({ command, ...result }, JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  } else if (command.startsWith('analysis ')) {
    const analysis = await import('../lib/analysis-session.mjs');
    const action = command.split(' ')[1];
    const integer = (name, fallback) => {
      if (options[name] === undefined) return fallback;
      if (!/^\d+$/.test(options[name]) || !Number.isSafeInteger(Number(options[name])))
        invalid(`--${name} 应为非负安全整数。`);
      return Number(options[name]);
    };
    let result;
    if (action === 'scan') {
      let scope = {};
      if (options.config) {
        try {
          scope = JSON.parse(fs.readFileSync(path.resolve(options.config), 'utf8'));
        } catch (error) {
          if (error instanceof SyntaxError) invalid('扫描配置不是有效 JSON。');
          throw error;
        }
      }
      result = await analysis.scanAnalysis(positional[0] || '.', scope);
    } else {
      if (!options.session) invalid('需要 --session 会话目录或 state.json。');
      if (action === 'list')
        result = analysis.listAnalysis(options.session, {
          offset: integer('offset', 0),
          limit: integer('limit', 50),
          status: options.status || 'all',
          kind: options.kind || 'units',
        });
      if (action === 'read') {
        if (options.input) {
          if (positional.length || options.offset !== undefined || options.length !== undefined)
            invalid('批量读取使用 reads 中的 id、offset、length，不与单项参数混用。');
          result = await analysis.readAnalysisBatch(options.session, inputObject());
        } else {
          if (!positional[0]) invalid('需要分析单元编号或 --input 读取批次。');
          result = await analysis.readAnalysis(options.session, positional[0], {
            offset: integer('offset', 0),
            length: integer('length', 16000),
          });
        }
      }
      if (action === 'record')
        result = await analysis.recordAnalysis(options.session, inputObject());
      if (action === 'trace') result = await analysis.traceAnalysis(options.session, inputObject());
      if (action === 'check') result = analysis.checkAnalysis(options.session);
    }
    emit({ command, ...result }, JSON.stringify(result, null, 2));
    if (result.valid === false) process.exitCode = 1;
  } else if (
    command.startsWith('feature ') ||
    command.startsWith('document ') ||
    command === 'apply'
  ) {
    const action = command.split(' ')[1];
    const needsId = command.startsWith('feature ') && action !== 'list';
    const id = needsId ? positional.shift() : undefined;
    if (needsId && (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)))
      invalid('请提供有效的功能编号（小写字母开头，最多 64 位小写字母、数字和连字符）。');
    const filename = documentFile(positional);
    if (isMutation()) {
      let bundle;
      if (command === 'apply') bundle = inputObject();
      else {
        if (!options['expected-hash']) invalid('写入需要 --expected-hash；请先读取最新文档哈希。');
        let operation = { op: `feature.${action}`, id };
        if (!['delete', 'sync'].includes(action)) {
          const payload = inputObject();
          if (action === 'create') operation.data = payload;
          if (action === 'update') operation.changes = payload;
          if (action === 'define') {
            inputFields(payload, ['description']);
            operation.description = payload.description;
          }
          if (action === 'complete') {
            inputFields(payload, ['revision', 'implementation', 'resolvedAnnotationIds']);
            operation = { ...operation, ...payload };
          }
        }
        bundle = { version: 1, expectedHash: options['expected-hash'], operations: [operation] };
      }
      const result = await applyChanges(filename, bundle, {
        dryRun: Boolean(options['dry-run']),
        render: !options['no-render'],
        analysisSession: options['analysis-session'],
        allowPartialAnalysis: Boolean(options['allow-partial-analysis']),
        requireVerification: Boolean(options['require-verification']),
        ...(options.output ? { output: path.resolve(options.output) } : {}),
      });
      emit({ command, document: filename, ...result }, mutationMessage(result));
    } else {
      const snapshot = readSnapshot(filename);
      let result, message;
      if (command === 'document check') {
        if (!options['analysis-session']) invalid('交付检查需要 --analysis-session。');
        const { checkDelivery } = await import('../lib/delivery.mjs');
        result = await checkDelivery(filename, options['analysis-session'], inputObject());
        message = JSON.stringify(result, null, 2);
        if (!result.valid) process.exitCode = 1;
      } else if (command === 'document status') {
        const { checkSourceStatus } = await import('../lib/source-status.mjs');
        result = {
          documentHash: snapshot.documentHash,
          sourceStatus: await checkSourceStatus(snapshot.document),
        };
        message = JSON.stringify(result.sourceStatus, null, 2);
      } else if (command === 'document get') {
        const section = options.section || 'all';
        if (!['all', 'product', 'dependencies', 'diagrams'].includes(section))
          invalid('--section 应为 all、product、dependencies 或 diagrams。');
        result = queryDocument(snapshot, { section });
        message =
          section === 'all'
            ? `${snapshot.document.product.name}\n${Object.keys(snapshot.document.features).length} 个功能，${snapshot.document.dependencies.length} 项依赖。`
            : JSON.stringify(result.data, null, 2);
      } else if (action === 'list') {
        if (options.status && !['draft', 'complete', 'unknown'].includes(options.status))
          invalid('--status 应为 draft、complete 或 unknown。');
        result = listFeatures(snapshot, { group: options.group, status: options.status });
        message =
          result.features
            .map(
              (feature) =>
                `${feature.id}  ${feature.title}  ${{ complete: '完成', draft: '草稿', unknown: '待确认' }[feature.status]}  ${(feature.groupPath || []).join(' / ') || '未分组'}`,
            )
            .join('\n') || '没有符合条件的功能。';
      } else {
        result = getFeature(snapshot, id, { related: Boolean(options.related) });
        message = `${result.feature.title} (${id})\n${result.feature.description}`;
        if (result.relatedDependencies)
          message += `\n关联依赖：${result.relatedDependencies.map((item) => item.name).join('、') || '无'}`;
      }
      emit(
        { command, document: filename, ...result },
        `${message}\n文档哈希：${result.documentHash}`,
      );
    }
  } else {
    const filename = documentFile(positional);
    let document;
    try {
      document = readDocument(filename);
    } catch (error) {
      if (error instanceof SyntaxError) error.code = 'VALIDATION_FAILED';
      throw error;
    }
    const report = validateDocument(document);
    if (command === 'validate') {
      emit(
        {
          command,
          document: filename,
          ...report,
          ...(!report.valid ? { code: 'VALIDATION_FAILED' } : {}),
        },
        report.valid
          ? `文档有效：${report.featureCount} 个功能，${report.dependencyCount} 项依赖。`
          : report.errors.map((item) => `${item.path}：${item.message}`).join('\n'),
      );
      if (!report.valid) process.exitCode = 1;
    } else if (command === 'render') {
      const output = path.resolve(
        options.output || path.join(path.dirname(filename), 'index.html'),
      );
      const result = await renderSnapshot(filename, { output });
      emit({ command, document: filename, ...result }, `已生成：${output}`);
    } else {
      if (!report.valid) throw Object.assign(new Error('文档校验失败，请先修正文档。'), { report });
      const port = options.port === undefined ? 62039 : Number(options.port);
      if (
        (options.port !== undefined && !/^\d+$/.test(options.port)) ||
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65535
      )
        invalid('端口应为 0–65535 的整数。');
      const server = createDocumentServer({ documentPath: filename, templatePath });
      server.on('error', fail);
      server.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        emit(
          { command, document: filename, url, port: server.address().port },
          `产品蓝图：${url}\n文档：${filename}`,
        );
      });
    }
  }
} catch (error) {
  fail(error);
}
