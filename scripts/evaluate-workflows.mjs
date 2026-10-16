import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readSnapshot } from '../lib/document-operations.mjs';
import { savePageAnnotation } from '../lib/feature-operations.mjs';
import { updateDocument } from '../lib/document-store.mjs';
import { renderSnapshot } from '../lib/document-operations.mjs';
import { scanAnalysis } from '../lib/analysis-session.mjs';
import { checkDelivery } from '../lib/delivery.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const hash = (content) => createHash('sha256').update(content).digest('hex');
export async function evaluateWorkflows(
  agent,
  {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-workflow-ai-')),
    timeoutMs = 600000,
    existingProject,
    resumeMaintenance = false,
  } = {},
) {
  if (
    !agent ||
    typeof agent.command !== 'string' ||
    !Array.isArray(agent.args) ||
    agent.args.some((arg) => typeof arg !== 'string')
  )
    throw Error('需要外部 AI 的 command/args 配置；不自动选择模型。');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw Error('评测目录必须为空。');
  const project = existingProject
    ? fs.realpathSync(existingProject)
    : path.join(directory, 'project');
  if (!existingProject) {
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, 'package.json'),
      ' {"name":"workflow-permission-sample","type":"module"}\n',
    );
    fs.writeFileSync(
      path.join(project, 'README.md'),
      '# 访问管理\n用户提供角色，admin 允许访问，其余角色拒绝。\n',
    );
    fs.writeFileSync(
      path.join(project, 'access.mjs'),
      "export function allowed(role) { return role === 'admin'; }\n",
    );
  }
  const filename = path.join(project, '.blueprint/product-document.json'),
    results = [];
  const execute = async (mode, request) => {
    const skill = path.join(repository, 'skills', `product-blueprint-${mode}`, 'SKILL.md');
    const prompt = `使用 ${skill}。目标仅为当前隔离项目 ${project}。CLI 是 ${process.execPath} ${path.join(repository, 'bin/product-blueprint.mjs')}。${request} 当前授权直接保存明确变更，不重复确认。按实际协议完成源码阅读、流程映射和验证；可解决缺口继续补齐，真实限制保留。此评测只需 CLI 产物，不启动服务和浏览器，不提交 Git。`;
    fs.writeFileSync(path.join(directory, `${mode}.prompt.txt`), prompt);
    const log = fs.openSync(path.join(directory, `${mode}.transcript.log`), 'wx', 0o600),
      startedAt = Date.now();
    const execution = await new Promise((resolve) => {
      const child = spawn(agent.command, agent.args, {
        cwd: project,
        shell: false,
        stdio: ['pipe', log, log],
        detached: process.platform !== 'win32',
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.platform !== 'win32'
            ? process.kill(-child.pid, 'SIGTERM')
            : child.kill('SIGTERM');
        } catch {}
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ error: error.message, exitCode: null, timedOut });
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, timedOut });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    fs.closeSync(log);
    return { mode, durationMs: Date.now() - startedAt, ...execution, errors: [] };
  };
  const save = () =>
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify({ directory, results }, null, 2) + '\n',
    );
  const initialHash = hash(fs.readFileSync(path.join(project, 'access.mjs')));
  let init;
  if (existingProject && resumeMaintenance)
    init = { mode: 'init', reused: true, historicalCheck: true, exitCode: 0, errors: [] };
  else if (existingProject) {
    const document = readSnapshot(filename).document,
      baseline = Object.values(document.features).find(
        (feature) => feature.implementation?.sourceSnapshot,
      )?.implementation.sourceSnapshot;
    const scan = await scanAnalysis(project, baseline?.scope || {}),
      review = JSON.parse(fs.readFileSync(path.join(project, '.blueprint/delivery-review.json')));
    const report = await checkDelivery(filename, scan.session, review);
    init = {
      mode: 'init',
      reused: true,
      exitCode: 0,
      errors: report.valid ? [] : report.gaps.map((gap) => gap.message),
    };
  } else
    init = await execute(
      'init',
      '为现有访问管理功能初始化 .blueprint/，已有实现实际核验完成。不得修改源码。',
    );
  try {
    const snapshot = readSnapshot(filename);
    if (hash(fs.readFileSync(path.join(project, 'access.mjs'))) !== initialHash)
      init.errors.push('初始化修改了原源码。');
    if (
      !Object.values(snapshot.document.features).some(
        (feature) => feature.implementedRevision === feature.revision,
      )
    )
      init.errors.push('已有功能未实际核验完成。');
  } catch (error) {
    init.errors.push(error.message);
  }
  init.valid = init.exitCode === 0 && !init.errors.length;
  results.push(init);
  save();
  console.log(
    JSON.stringify({
      mode: 'init',
      valid: init.valid,
      report: path.join(directory, 'report.json'),
    }),
  );
  if (!init.valid) return { directory, results };
  const before = readSnapshot(filename),
    target = Object.values(before.document.features).find(
      (feature) => feature.implementedRevision === feature.revision,
    );
  const maintain = await execute(
    'maintain',
    `这是同一授权维护任务的继续，已有进度保留，补齐工具指出的缺项后完成保存。明确需求：viewer 与 admin 一样可以访问，其他角色仍拒绝。只更新现有功能 ${target.id} 的蓝图定义、规则和流程，源码保持原样，不登记新的完成。`,
  );
  try {
    const feature = readSnapshot(filename).document.features[target.id];
    if (hash(fs.readFileSync(path.join(project, 'access.mjs'))) !== initialHash)
      maintain.errors.push('维护越权修改了源码。');
    if (
      feature.revision <= target.revision ||
      feature.implementedRevision === feature.revision ||
      !JSON.stringify(feature).includes('viewer')
    )
      maintain.errors.push('需求没有形成保留旧历史的待实现定义。');
  } catch (error) {
    maintain.errors.push(error.message);
  }
  maintain.valid = maintain.exitCode === 0 && !maintain.errors.length;
  results.push(maintain);
  save();
  console.log(
    JSON.stringify({
      mode: 'maintain',
      valid: maintain.valid,
      report: path.join(directory, 'report.json'),
    }),
  );
  if (!maintain.valid) return { directory, results };
  for (const [id, text] of [
    ['annotation-viewer', '实现 viewer 访问权限，保留 admin 允许，其余拒绝。'],
    ['annotation-later', '未来另行讨论 CSV 导出，本次不处理。'],
  ]) {
    const feature = readSnapshot(filename).document.features[target.id];
    await updateDocument(
      filename,
      savePageAnnotation({
        id: target.id,
        annotationId: id,
        text,
        expectedRevision: feature.revision,
        expectedEditRevision: feature.editRevision ?? 0,
      }),
    );
  }
  await renderSnapshot(filename);
  const implement = await execute(
    'implement',
    `实现刚保存的功能 ${target.id}，处理 annotation-viewer；annotation-later 的 CSV 导出本次明确不实现且须保留。实际验证 admin、viewer 允许，member、空角色拒绝。同步流程与完成状态，并只清理本次处理批注。`,
  );
  try {
    const feature = readSnapshot(filename).document.features[target.id];
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import assert from 'node:assert/strict';import {allowed} from './access.mjs';assert.equal(allowed('admin'),true);assert.equal(allowed('viewer'),true);assert.equal(allowed('member'),false);assert.equal(allowed(''),false);",
      ],
      { cwd: project, encoding: 'utf8', timeout: 30000 },
    );
    if (run.status !== 0) implement.errors.push('独立业务断言失败：' + run.stderr);
    if (feature.implementedRevision !== feature.revision)
      implement.errors.push('当前定义没有完成登记。');
    if (
      feature.annotations?.some((note) => note.id === 'annotation-viewer') ||
      !feature.annotations?.some((note) => note.id === 'annotation-later')
    )
      implement.errors.push('批注清理范围错误。');
    if (!feature.implementationHistory?.length) implement.errors.push('原验收历史未保留。');
  } catch (error) {
    implement.errors.push(error.message);
  }
  implement.valid = implement.exitCode === 0 && !implement.errors.length;
  results.push(implement);
  save();
  console.log(
    JSON.stringify({
      mode: 'implement',
      valid: implement.valid,
      report: path.join(directory, 'report.json'),
    }),
  );
  return { directory, results };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = process.argv[2];
  if (!config)
    throw Error(
      '用法：node scripts/evaluate-workflows.mjs agent.json [全新输出目录]；会调用真实 AI。',
    );
  const report = await evaluateWorkflows(JSON.parse(fs.readFileSync(config)), {
    directory: process.argv[3],
    existingProject: process.argv[4],
    resumeMaintenance: process.argv[5] === '--resume-maintain',
    timeoutMs: 1200000,
  });
  if (report.results.some((result) => !result.valid)) process.exitCode = 1;
}
