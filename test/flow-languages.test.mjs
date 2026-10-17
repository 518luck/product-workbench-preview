import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  scanAnalysis,
  loadSession,
  readAnalysis,
  recordAnalysis,
} from '../lib/analysis-session.mjs';
import { createFeature } from '../lib/feature-operations.mjs';
import { saveVerificationPlan } from '../lib/verification-plan.mjs';
import { recordFlows, checkFlows } from '../lib/flow.mjs';
import { readSnapshot } from '../lib/document-operations.mjs';
import { runVerification } from '../lib/verification.mjs';

const samples = [
  {
    language: 'python',
    file: 'main.py',
    source:
      '# 中文与 emoji 😀 的位置转换\ndef normalize(value):\n    if value < 0: raise ValueError("bad")\n    return value + 1\n\ndef submit(value):\n    return normalize(value)\n',
    negative: {
      command: 'python3',
      args: ['-c', 'from main import submit\ntry: submit(-1)\nexcept ValueError: pass'],
    },
    run: { command: 'python3', args: ['-c', 'from main import submit; assert submit(2.0) == 3'] },
  },
  {
    language: 'go',
    negative: {
      command: './flow-bin',
      args: ['negative'],
      build: [{ command: 'go', args: ['build', '-o', 'flow-bin', '.'] }],
    },
    file: 'main.go',
    source:
      '// 中文与 emoji 😀 的位置转换\npackage main\nimport "os"\nfunc normalize(value int) int { if value<0 {panic("bad")};return value + 1 }\nfunc submit(value int) int { return normalize(value) }\nfunc main(){defer func(){recover()}();if len(os.Args)>1 {submit(-1)}else{submit(2)}}\n',
    run: {
      command: './flow-bin',
      args: [],
      build: [{ command: 'go', args: ['build', '-o', 'flow-bin', '.'] }],
    },
    extra: { 'go.mod': 'module sample\n\ngo 1.26.0\n' },
  },
  {
    language: 'cpp',
    negative: {
      command: './flow-bin',
      args: ['negative'],
      build: [{ command: 'clang++', args: ['-std=c++17', 'main.cpp', '-o', 'flow-bin'] }],
    },
    file: 'main.cpp',
    source:
      '// 中文与 emoji 😀 的位置转换\nint normalize(int value) { if(value<0)throw value;return value + 1; }\nint submit(int value) { return normalize(value); }\nint main(int argc,char** argv){try{submit(argc>1?-1:2);}catch(...){}return 0;}\n',
    run: {
      command: './flow-bin',
      args: [],
      build: [{ command: 'clang++', args: ['-std=c++17', 'main.cpp', '-o', 'flow-bin'] }],
    },
  },
];
for (const sample of samples)
  test(`${sample.language}：语法、语义调用、真实参数与返回证据；错误声明不能通过`, async (t) => {
    const tool =
      sample.language === 'python' ? 'python3' : sample.language === 'go' ? 'go' : 'clang++';
    if (spawnSync(tool, ['--version'], { encoding: 'utf8' }).error)
      return t.skip(`本机未安装 ${tool}`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-language-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, sample.file), sample.source);
    for (const [file, text] of Object.entries(sample.extra || {}))
      fs.writeFileSync(path.join(root, file), text);
    if (sample.language === 'cpp')
      fs.writeFileSync(
        path.join(root, 'compile_commands.json'),
        JSON.stringify([
          {
            directory: root,
            file: 'main.cpp',
            arguments: ['clang++', '-std=c++17', '-c', 'main.cpp'],
          },
        ]),
      );
    const filename = path.join(root, 'product-document.json');
    fs.copyFileSync(new URL('../examples/minimal-product.json', import.meta.url), filename);
    const scan = await scanAnalysis(root),
      session = scan.session,
      state = loadSession(session).state;
    assert.equal(state.gaps.length, 0, JSON.stringify(state.gaps));
    const from = state.units.find((unit) => unit.name === 'submit'),
      to = state.units.find((unit) => unit.name === 'normalize'),
      call = from.calls.find((call) => call.expression === 'normalize');
    assert.equal(call.target, to.id, JSON.stringify({ call, units: state.units }));
    assert.ok(from.parameters.length && to.returns.length);
    const flow = {
      id: 'number-flow',
      title: '数值转换',
      entryId: `entry-${from.id}`,
      nodes: [
        {
          id: 'submit',
          featureId: 'stock-receipt',
          step: 0,
          unitId: from.id,
          inputs: [call.resultId],
          outputs: [call.argumentIds[0], ...from.returns],
        },
        {
          id: 'normalize',
          featureId: 'stock-receipt',
          step: 1,
          unitId: to.id,
          pointIds: to.reviewPoints
            .filter((point) => ['conditions', 'exceptions', 'sideEffects'].includes(point.field))
            .map((point) => point.id),
          inputs: [to.parameters[0]],
          outputs: [to.returns[0]],
        },
      ],
      edges: [
        { id: 'call', from: 'submit', to: 'normalize', kind: 'call', callId: call.id },
        {
          id: 'input',
          from: 'submit',
          to: 'normalize',
          kind: 'data',
          sourceId: call.argumentIds[0],
          targetId: to.parameters[0],
        },
        {
          id: 'output',
          from: 'normalize',
          to: 'submit',
          kind: 'data',
          sourceId: to.returns[0],
          targetId: call.resultId,
        },
      ],
      scenarios: [
        {
          id: 'normal',
          title: '输入2输出3',
          kind: 'normal',
          entryNode: 'submit',
          terminalNodes: ['submit'],
          edges: ['call', 'input', 'output'],
          assertions: [{ nodeId: 'submit', event: 'return', operator: 'equals', expected: 3 }],
        },
      ],
    };
    const unsafe = structuredClone(flow);
    unsafe.scenarios[0].assertions[0].expected = Number.MAX_SAFE_INTEGER + 1;
    await assert.rejects(
      recordFlows(filename, session, {
        expectedHash: readSnapshot(filename).documentHash,
        flows: [unsafe],
      }),
      /安全整数/,
    );
    await recordFlows(filename, session, {
      expectedHash: readSnapshot(filename).documentHash,
      flows: [flow],
    });
    const noBusiness = await runVerification(filename, 'stock-receipt', session, {
      command: process.execPath,
      args: ['-e', 'console.log("business passed")'],
      flow: { id: flow.id, scenarioId: 'normal' },
    });
    assert.equal(noBusiness.valid, true, '普通命令可以执行成功，但不能证明业务已执行');
    assert.equal(noBusiness.eventCount, 0);
    assert.equal(checkFlows(filename, session, { id: flow.id }).flows[0].scenarios[0].valid, false);
    const run = await runVerification(filename, 'stock-receipt', session, {
      ...sample.run,
      flow: { id: flow.id, scenarioId: 'normal' },
      timeoutMs: 60000,
    });
    const record = JSON.parse(fs.readFileSync(run.record));
    assert.equal(
      run.valid,
      true,
      JSON.stringify({
        run,
        stderr: fs.readFileSync(run.record.replace(/\.json$/, '.stderr.log'), 'utf8'),
        record,
      }),
    );
    const result = checkFlows(filename, session, { id: flow.id });
    // These fixtures exercise machine facts and runtime boundaries. They deliberately have no AI analysis records.
    assert.ok(
      !result.flows[0].gaps.some(
        (gap) => !['analysis', 'coverage', 'scenario', 'branch'].includes(gap.kind),
      ),
      JSON.stringify(result),
    );
    assert.ok(result.flows[0].scenarios[0].valid, JSON.stringify(result));
    assert.ok(
      result.flows[0].gaps.some((gap) => ['branch', 'scenario'].includes(gap.kind)),
      '正常路径不能代替异常覆盖',
    );
    const disconnected = structuredClone(flow);
    disconnected.edges = disconnected.edges.filter((edge) => edge.id !== 'input');
    disconnected.scenarios[0].edges = disconnected.scenarios[0].edges.filter(
      (id) => id !== 'input',
    );
    await recordFlows(filename, session, {
      expectedHash: readSnapshot(filename).documentHash,
      flows: [disconnected],
    });
    assert.ok(
      checkFlows(filename, session, { id: flow.id }).gaps.some((gap) => gap.kind === 'interface'),
      '函数确有调用，但缺少参数连接的流程不能通过',
    );
    flow.scenarios.push({
      id: 'error',
      title: '负数失败',
      kind: 'exception',
      entryNode: 'submit',
      terminalNodes: ['normalize'],
      edges: ['call', 'input'],
      assertions: [{ nodeId: 'normalize', event: 'throw', operator: 'exists' }],
    });
    await recordFlows(filename, session, {
      expectedHash: readSnapshot(filename).documentHash,
      flows: [flow],
    });
    await runVerification(filename, 'stock-receipt', session, {
      ...sample.run,
      flow: { id: flow.id, scenarioId: 'normal' },
      timeoutMs: 60000,
    });
    const failedPath = await runVerification(filename, 'stock-receipt', session, {
      ...sample.negative,
      flow: { id: flow.id, scenarioId: 'error' },
      timeoutMs: 60000,
    });
    assert.equal(
      failedPath.valid,
      true,
      JSON.stringify({
        failedPath,
        stderr: fs.readFileSync(failedPath.record.replace(/\.json$/, '.stderr.log'), 'utf8'),
      }),
    );
    const both = checkFlows(filename, session, { id: flow.id });
    assert.ok(
      both.flows[0].scenarios.every((scenario) => scenario.valid),
      JSON.stringify(both),
    );
    assert.ok(
      !both.gaps.some((gap) => ['branch', 'scenario'].includes(gap.kind)),
      JSON.stringify(both),
    );
    flow.scenarios[0].assertions[0].expected = 4;
    await recordFlows(filename, session, {
      expectedHash: readSnapshot(filename).documentHash,
      flows: [flow],
    });
    await runVerification(filename, 'stock-receipt', session, {
      ...sample.run,
      flow: { id: flow.id, scenarioId: 'normal' },
      timeoutMs: 60000,
    });
    assert.equal(checkFlows(filename, session, { id: flow.id }).flows[0].status, 'failed');
    assert.equal(fs.readFileSync(path.join(root, sample.file), 'utf8'), sample.source);
    await t.test('组件场景同样核对实际返回，错误结果和未执行不能通过', async () => {
      const feature = createFeature('number-component', {
        title: '数值转换',
        description: '将传入数值加一。',
        checks: ['输入 2 时返回 3。'],
        flow: [['转换', '把数值交给规范化函数加一']],
        stepDetails: [
          {
            actor: '调用方',
            description: '',
            rules: [],
            dependencies: [],
            result: '返回加一的数值',
            exception: '',
            acceptance: '输入 2 返回 3',
            interactions: [],
          },
        ],
      });
      fs.writeFileSync(
        filename,
        JSON.stringify({
          schemaVersion: 1,
          product: { name: '数值转换器' },
          features: { 'number-component': feature },
          dependencies: [],
        }),
      );
      const read = await readAnalysis(session, from.id);
      const meaning = '将传入数值交给 normalize 加一，并返回相加结果；负数错误向调用方传播。';
      await recordAnalysis(session, {
        records: [
          {
            unitId: from.id,
            receiptIds: [read.receipt.id],
            responsibility: meaning,
            inputs: ['value 是待转换的整数。'],
            outputs: [meaning],
            conditions: [],
            calls: [meaning],
            sideEffects: [],
            exceptions: ['负数错误向调用方传播。'],
            unknowns: [],
            coverage: from.reviewPoints.map((p) => ({
              pointId: p.id,
              detail: p.field === 'inputs' ? 'value 是待转换的整数。' : meaning,
            })),
          },
        ],
      });
      const input = {
        id: 'number-plan',
        featureId: 'number-component',
        goal: '数值加一',
        expectedHash: readSnapshot(filename).documentHash,
        steps: [{ step: 0, level: 'component', unitIds: [from.id], scenarioIds: ['normal'] }],
        scenarios: [
          {
            id: 'normal',
            kind: 'normal',
            level: 'component',
            steps: [0],
            criteria: [0],
            assertion: '输入 2 返回 3',
            observations: [
              {
                step: 0,
                criterion: 0,
                unitId: from.id,
                event: 'return',
                operator: 'equals',
                expected: 3,
              },
            ],
          },
        ],
      };
      await saveVerificationPlan(filename, session, input);
      const scope = { planId: input.id, scenarioId: 'normal' };
      const noRun = await runVerification(filename, 'number-component', session, {
        command: process.execPath,
        args: ['-e', 'console.log("passed")'],
        scope,
      });
      assert.equal(noRun.valid, false);
      const actual = await runVerification(filename, 'number-component', session, {
        ...sample.run,
        scope,
      });
      assert.equal(actual.valid, true, JSON.stringify(actual));
      input.scenarios[0].observations[0].expected = 4;
      await saveVerificationPlan(filename, session, input);
      const wrong = await runVerification(filename, 'number-component', session, {
        ...sample.run,
        scope,
      });
      assert.equal(wrong.exitCode, 0);
      assert.equal(wrong.valid, false);
      assert.equal(fs.readFileSync(path.join(root, sample.file), 'utf8'), sample.source);
    });
  });
