import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkDelivery } from '../lib/delivery.mjs';
import { scanAnalysis } from '../lib/analysis-session.mjs';
import { inventory, indexSnapshot } from '../lib/analysis-index.mjs';
import { readSnapshot, featureStatus } from '../lib/document-operations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/product-blueprint.mjs');
const skill = path.join(root, 'skills/product-blueprint-init/SKILL.md');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const access = "export function allowed(role) { return role === 'admin'; }\n";
export const cases = [
  { id: 'implemented', description: '已有管理员访问功能，应按源码判定已实现。' },
  {
    id: 'requested',
    description: '已有管理员访问与尚未实现的 CSV 导出需求，应区分完成与草稿。',
    requested: true,
  },
  {
    id: 'preserve-example',
    description: '保留根目录另一个产品示例，生成到 .blueprint。',
    example: true,
  },
  { id: 'nested', description: '完整分析嵌套函数与另一文件，不能只读取入口。', nested: true },
  { id: 'resume', description: '恢复已有未完成分析，不把保存进度当作交付完成。', resume: true },
  {
    id: 'collaboration',
    description: '保存批注、按批注修改定义与实现、验收后清理的完整协作旅程。',
    collaboration: true,
  },
];
export async function prepareCase(directory, item) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw Error('评测输出目录必须为空，防止旧产物影响评分。');
  const files = {
    'access.mjs': access,
    'package.json': '{"name":"access-control","type":"module"}\n',
  };
  if (item.nested)
    files['normalize.mjs'] =
      'export function normalizedRole(value) { function trim(v) { return v.trim(); } return trim(value); }\n';
  files['README.md'] =
    '# 访问管理\n用户提交角色，管理员允许访问，普通成员及其他角色拒绝。' +
    (item.requested
      ? '\n未来新增独立功能：将访问记录导出为 CSV。当前项目尚未实现导出，不要在初始化时开发。'
      : '') +
    '\n';
  if (item.collaboration) {
    delete files['access.mjs'];
    files['package.json'] = '{"name":"annotation-workflow","type":"module"}\n';
    files['workflow.mjs'] = `export function saveAnnotation(book, text) {
  if (!text.trim()) throw new Error('批注不能为空');
  const note = {id: String(book.nextId++), text};
  book.annotations.push(note);
  return note.id;
}
export function reviseFeature(book, id, applyBehavior) {
  const note = book.annotations.find(item => item.id === id);
  if (!note) throw new Error('批注不存在');
  book.definition = note.text;
  book.revision++;
  book.status = 'draft';
  applyBehavior(note.text);
}
export function completeFeature(book, id, passed) {
  if (!passed) throw new Error('验收失败，保留批注');
  if (!book.annotations.some(item => item.id === id)) throw new Error('批注不存在');
  book.implementedRevision = book.revision;
  book.status = 'complete';
  book.annotations = book.annotations.filter(item => item.id !== id);
}
`;
    files['README.md'] =
      '# 批注协作板\n人先阅读功能定义，再保存自然语言批注；外部 AI 读取已保存批注，用 reviseFeature 整理定义并通过调用方提供的 applyBehavior 修改行为；完成实际验收后，completeFeature 同步完成版本并只清理处理的那条批注。页面本身不运行模型。验收失败、未知批注与空输入是明确异常。saveAnnotation 只保存原文，不改变功能完成状态；未处理批注保留。核心旅程是保存修改意图 → 按批注更新定义和实现 → 验收、同步并清理。\n';
  }
  if (item.example)
    files['product-document.json'] = fs.readFileSync(
      path.join(root, 'examples/minimal-product.json'),
      'utf8',
    );
  for (const [file, content] of Object.entries(files))
    fs.writeFileSync(path.join(directory, file), content);
  if (item.resume) await scanAnalysis(directory);
  return Object.fromEntries(Object.entries(files).map(([file, content]) => [file, hash(content)]));
}
export function checkOriginalScope(directory, original, scope) {
  const errors = [];
  const expected = indexSnapshot(inventory(directory));
  const selected = indexSnapshot(inventory(directory, scope));
  const selectedUnits = new Set(selected.units.map((unit) => unit.id));
  for (const unit of expected.units)
    if (Object.hasOwn(original, unit.file) && !selectedUnits.has(unit.id))
      errors.push(`原始源码单元未纳入交付范围：${unit.file}: ${unit.name}`);
  for (const file of expected.manifest)
    if (
      Object.hasOwn(original, file.file) &&
      ['source', 'types', 'context'].includes(file.kind) &&
      !selected.manifest.some(
        (item) => item.file === file.file && item.kind === file.kind && item.hash === file.hash,
      )
    )
      errors.push(`原始源码或配置未纳入交付范围：${file.file}`);
  return errors;
}
export function checkArtifactLayout(directory, original) {
  const errors = [];
  const deliveries = new Set([
    '.blueprint/product-document.json',
    '.blueprint/index.html',
    '.blueprint/delivery-review.json',
  ]);
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (Object.hasOwn(original, file)) continue;
      if (file === '.blueprint-analysis' && entry.isDirectory()) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isSymbolicLink() || !deliveries.has(file))
        errors.push(`生成产物不在约定位置：${file}`);
    }
  }
  visit();
  return errors;
}
export async function gradeCase(directory, item, original) {
  const errors = checkArtifactLayout(directory, original);
  let delivery;
  for (const [file, digest] of Object.entries(original)) {
    try {
      if (hash(fs.readFileSync(path.join(directory, file))) !== digest)
        errors.push(`输入文件被修改：${file}`);
    } catch {
      errors.push(`输入文件丢失：${file}`);
    }
  }
  try {
    const filename = path.join(directory, '.blueprint/product-document.json');
    const document = readSnapshot(filename).document;
    const features = Object.values(document.features);
    const existing = features.find((f) =>
      /admin|管理员/i.test(JSON.stringify([f.description, f.rules, f.stepDetails])),
    );
    if (!item.collaboration && (!existing || featureStatus(existing) !== 'complete'))
      errors.push('已有管理员访问未核对为已实现。');
    if (
      !item.collaboration &&
      existing &&
      !/member|普通|其他/i.test(JSON.stringify([existing.rules, existing.stepDetails]))
    )
      errors.push('遗漏非管理员拒绝规则。');
    if (item.requested) {
      const requested = features.find((f) => /csv|导出/i.test(f.description));
      if (!requested || featureStatus(requested) !== 'draft')
        errors.push('未实现导出需求没有保留草稿。');
    }
    const review = JSON.parse(
      fs.readFileSync(path.join(directory, '.blueprint/delivery-review.json'), 'utf8'),
    );
    if (item.collaboration) {
      if (!features.length || features.some((feature) => featureStatus(feature) !== 'complete'))
        errors.push('已有批注协作能力未核对为已实现。');
      const journey = review.journeys?.find((journey) => {
        const steps = journey.steps
          ?.map((mapping) => document.features[mapping.featureId]?.flow?.[mapping.step])
          .flat()
          .join(' ');
        return (
          /批注/.test(steps) &&
          /修改|更新|整理/.test(steps) &&
          /验收|完成/.test(steps) &&
          /清理|删除/.test(steps)
        );
      });
      if (!journey) errors.push('核心旅程遗漏批注、修改实现、验收同步或清理。');
      if (!features.some((feature) => feature.sequence?.error?.length))
        errors.push('未表达实际异常时序分支。');
      if (!features.some((feature) => feature.dataflow?.nodes?.length))
        errors.push('未表达批注与定义版本的数据流。');
      if (!document.diagrams?.architecture?.edges?.length)
        errors.push('未表达人与外部 AI 的协作架构。');
    }
    const baseline = features
      .map(
        (feature) =>
          feature.implementationAssessment?.sourceSnapshot ||
          feature.implementation?.sourceSnapshot,
      )
      .find(Boolean);
    const scan = await scanAnalysis(directory, baseline?.scope ?? {});
    // Scope may legitimately exclude generated artifacts. Independently require every original
    // authored unit and configuration, rather than trusting a narrower scope chosen by the AI.
    errors.push(...checkOriginalScope(directory, original, baseline?.scope ?? {}));
    delivery = await checkDelivery(filename, scan.session, review, { mode: 'source' });
    if (!delivery.valid)
      errors.push(...delivery.gaps.map((g) => `${g.kind}: ${g.path}: ${g.message}`));
  } catch (error) {
    errors.push(error.message);
  }
  return { valid: errors.length === 0, errors, delivery };
}
export async function runSuite({
  agent,
  trials = 3,
  caseIds = cases.map((c) => c.id),
  timeoutMs = 1200000,
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-ai-evals-')),
}) {
  if (
    !agent ||
    typeof agent.command !== 'string' ||
    !Array.isArray(agent.args) ||
    agent.args.some((v) => typeof v !== 'string')
  )
    throw Error('agent JSON 必须提供 command 与字符串 args 数组。');
  if (
    !Number.isSafeInteger(trials) ||
    trials < 1 ||
    trials > 20 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw Error('无效 trials 或 timeoutMs。');
  const selected = cases.filter((c) => caseIds.includes(c.id));
  if (selected.length !== caseIds.length) throw Error('未知或重复 case。');
  fs.mkdirSync(directory, { recursive: true });
  const results = [];
  for (const item of selected)
    for (let trial = 1; trial <= trials; trial++) {
      const project = path.join(directory, `${item.id}-${trial}`),
        original = await prepareCase(project, item);
      fs.writeFileSync(
        path.join(directory, `${item.id}-${trial}.inputs.json`),
        JSON.stringify(original, null, 2) + '\n',
      );
      const prompt = `使用 ${skill} 为当前临时项目初始化产品书，保留已有示例与源码。CLI 使用 ${process.execPath} ${cli}。读取实际协议及 references；已有功能按源码核对实现状态，未来需求保留草稿，不执行运行验收或生成 executionId。最终保存 v5 交付审阅并运行 document check --mode source，只有当前 completion.canDeliver:true 才宣布产品书生成完成；只需 CLI 产品书交付，不启动浏览器服务。分析缺口继续处理；任务不需要修改原项目源码。`;
      fs.writeFileSync(path.join(directory, `${item.id}-${trial}.prompt.txt`), prompt);
      const replace = (value) =>
        value
          .replaceAll('{{project}}', project)
          .replaceAll('{{cli}}', cli)
          .replaceAll('{{skill}}', skill);
      const log = fs.openSync(
        path.join(directory, `${item.id}-${trial}.transcript.log`),
        'wx',
        0o600,
      );
      const started = Date.now();
      let execution;
      try {
        execution = await new Promise((resolve) => {
          const child = spawn(agent.command, agent.args.map(replace), {
            cwd: project,
            shell: false,
            stdio: ['pipe', log, log],
          });
          let force;
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            force = setTimeout(() => child.kill('SIGKILL'), 5000);
          }, timeoutMs);
          child.once('error', (error) => {
            clearTimeout(timer);
            clearTimeout(force);
            resolve({ exitCode: null, error: error.message });
          });
          child.once('close', (exitCode, signal) => {
            clearTimeout(timer);
            clearTimeout(force);
            resolve({ exitCode, signal });
          });
          child.stdin.on('error', () => {});
          child.stdin.end(prompt);
        });
      } finally {
        fs.closeSync(log);
      }
      const grade = await gradeCase(project, item, original);
      const result = {
        caseId: item.id,
        trial,
        durationMs: Date.now() - started,
        ...execution,
        ...grade,
      };
      if (execution.exitCode !== 0) {
        result.valid = false;
        result.errors.push('外部 AI 进程未正常完成。');
      }
      results.push(result);
      const summary = {
        directory,
        trials,
        expectedTotal: selected.length * trials,
        suiteStatus: results.length === selected.length * trials ? 'complete' : 'running',
        total: results.length,
        passed: results.filter((r) => r.valid).length,
        allTrialsPassed: cases
          .filter((c) => selected.includes(c))
          .map((c) => ({
            caseId: c.id,
            passed:
              results.filter((r) => r.caseId === c.id).length === trials &&
              results.filter((r) => r.caseId === c.id).every((r) => r.valid),
          })),
        results,
      };
      fs.writeFileSync(
        path.join(directory, 'report.json'),
        JSON.stringify(summary, null, 2) + '\n',
      );
      console.log(
        JSON.stringify({
          caseId: item.id,
          trial,
          valid: result.valid,
          errors: result.errors.slice(0, 5),
          report: path.join(directory, 'report.json'),
        }),
      );
    }
  return { directory, results };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--agent', '--trials', '--case', '--timeout-ms', '--output'].includes(args[i]) ||
      !args[i + 1] ||
      options[args[i]]
    )
      throw Error(
        '用法：node scripts/evaluate-init.mjs --agent 命令.json [--trials 3] [--case implemented] [--timeout-ms 1200000] [--output 新目录]',
      );
    options[args[i]] = args[i + 1];
  }
  if (!options['--agent']) throw Error('需要 --agent 命令.json；不会自动启动或假装已运行模型。');
  const result = await runSuite({
    agent: JSON.parse(fs.readFileSync(options['--agent'], 'utf8')),
    trials: Number(options['--trials'] ?? 3),
    caseIds: options['--case'] ? options['--case'].split(',') : undefined,
    timeoutMs: Number(options['--timeout-ms'] ?? 1200000),
    directory: options['--output'],
  });
  if (result.results.some((r) => !r.valid)) process.exitCode = 1;
}
