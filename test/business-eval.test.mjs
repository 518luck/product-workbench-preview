import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  businessCases,
  prepareBusinessCase,
  gradeBusinessCase,
  evaluateBusiness,
} from '../scripts/evaluate-business.mjs';
import { scanAnalysis, loadSession, readAnalysisPack } from '../lib/analysis-session.mjs';
import { recordBusinessModel } from '../lib/business-model.mjs';
import { recordDiscovery } from '../lib/discovery.mjs';

test('跨领域预设操作/结果评分拒绝空产物、错 helper 和篡改输入，不按功能名称打分', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-business-gold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const item of businessCases) {
    const directory = path.join(root, item.id),
      original = prepareBusinessCase(directory, item);
    assert.equal(gradeBusinessCase(directory, item, original).valid, false);
    const { session } = await scanAnalysis(directory, { contexts: ['README.md'] }),
      { state } = loadSession(session);
    const capabilities = item.atoms.map((atom, index) => {
      const op = state.facts.operations.find(
        (o) =>
          (!atom.surface || o.surface === atom.surface) &&
          (!atom.file || o.file === atom.file) &&
          Object.entries(atom.trigger || {}).every(([k, v]) => o.trigger[k] === v),
      );
      const unit = atom.result.name && state.units.find((u) => u.name === atom.result.name);
      return {
        id: `capability-${index}`,
        title: `用户目标 ${index}`,
        actor: '项目使用者',
        goal: '通过独立入口获取结果',
        outcome: '获得规则规定的结果',
        operationIds: [op.id],
        results: [
          unit
            ? {
                kind: 'code',
                unitId: unit.id,
                pointId: unit.reviewPoints.find((p) => p.code.includes(atom.result.contains)).id,
                detail: '核对该业务操作的状态写入或返回结果。',
              }
            : {
                kind: 'context',
                contextId: state.contexts.find((c) => c.file === atom.result.file).id,
                quote: atom.result.quote,
              },
        ],
      };
    });
    const covered = new Set(capabilities.flatMap((c) => c.operationIds));
    const input = {
      version: 1,
      capabilities,
      dispositions: state.facts.operations
        .filter((op) => !covered.has(op.id))
        .map((op) => ({
          operationId: op.id,
          kind:
            op.surface === 'library' ||
            op.surface === 'cli-dispatch' ||
            op.surface === 'registration'
              ? 'internal'
              : 'support',
          capabilityIds: capabilities.map((c) => c.id),
          reason:
            op.trigger.name === 'enable'
              ? '库导出把订阅标志设置为开启，公开 enable 命令已映射到该业务。'
              : op.trigger.name === 'disable'
                ? '库导出把订阅标志设置为关闭，对应取消订阅目标。'
                : op.trigger.name === 'snapshot'
                  ? '只读取内存中的订阅状态并包装为对象，不改变订阅。'
                  : op.surface === 'cli-dispatch'
                    ? '从进程参数选出具体命令的启动脚手架，两个实际命令已分别归属业务。'
                    : `本夹具操作 ${JSON.stringify(op.trigger)} 的共享技术支撑，另有明确的业务目标映射。`,
          source: op.registration.file,
        })),
    };
    await recordBusinessModel(session, input);
    const grade = gradeBusinessCase(directory, item, original);
    assert.equal(grade.valid, true, item.id + JSON.stringify(grade.errors));
    if (item.id === 'workflow-and-api') {
      for (const file of Object.keys(item.files)) await readAnalysisPack(session, file);
      const discovery = {
        version: 1,
        model: input,
        modules: [
          {
            directory: '.',
            status: 'mapped',
            capabilityIds: capabilities.slice(0, 2).map((c) => c.id),
            reason: '订单 HTTP 服务为客户分别创建订单和取消订单；委托工作流另有原文入口。',
          },
        ],
      };
      assert.equal((await recordDiscovery(session, discovery)).valid, true);
      const stageGrade = gradeBusinessCase(directory, item, original, { stage: 'discover' });
      assert.equal(stageGrade.valid, true, JSON.stringify(stageGrade.errors));
      assert.equal(stageGrade.matchedAtoms, 5);
      assert.equal(Object.keys(loadSession(session).state.records).length, 0);
      discovery.model = { ...input, capabilities: capabilities.slice(2), dispositions: [] };
      discovery.modules = [
        {
          directory: '.',
          status: 'pending',
          capabilityIds: [],
          reason: '订单接口尚未归属用户目标。',
        },
      ];
      assert.equal((await recordDiscovery(session, discovery)).valid, false);
      const incomplete = gradeBusinessCase(directory, item, original, { stage: 'discover' });
      assert.equal(incomplete.valid, false);
      assert.equal(incomplete.matchedAtoms, 3);
    }
    if (item.id === 'dispatch' || item.id.endsWith('-routes')) {
      const unit = state.units.find((u) => u.name === 'snapshot');
      input.capabilities[0].results = [
        {
          kind: 'code',
          unitId: unit.id,
          pointId: unit.reviewPoints[0].id,
          detail: '错误地把状态包装当成开启订阅。',
        },
      ];
      await recordBusinessModel(session, input);
      const bad = gradeBusinessCase(directory, item, original);
      assert.equal(bad.valid, false);
      assert.ok(bad.errors.some((e) => e.includes('错映射')));
    }
    fs.appendFileSync(path.join(directory, Object.keys(original)[0]), '\n篡改');
    assert.ok(
      gradeBusinessCase(directory, item, original).errors.some((e) => e.includes('输入被修改')),
    );
  }
});

test('外部 AI 仅输出成功不通过业务评测，运行失败和结果评分分别记录', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-business-runner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await evaluateBusiness(
    { command: process.execPath, args: ['-e', "console.log('已理解全部业务')"] },
    { directory, timeoutMs: 1000 },
  );
  assert.equal(result.passed, 0);
  assert.equal(result.total, businessCases.length);
  assert.ok(result.results.every((r) => r.exitCode === 0 && !r.valid));
});

test('评测只执行所选发现样例；预算耗尽为失败而非初始化完成', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-discovery-one-case-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = await evaluateBusiness(
    { command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] },
    { directory, caseIds: ['workflow-and-api'], stage: 'discover', timeoutMs: 100 },
  );
  assert.equal(report.total, 1);
  assert.equal(report.passed, 0);
  assert.equal(report.results[0].timedOut, true);
  assert.equal(report.results[0].stage, 'discover');
  assert.equal(fs.existsSync(path.join(directory, 'notes-1')), false);
  assert.equal(fs.existsSync(path.join(directory, 'workflow-and-api-1', '.blueprint')), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(directory, 'workflow-and-api-1', '.blueprint-workflow.json')),
    ).skills.verify.enabled,
    false,
  );
});
