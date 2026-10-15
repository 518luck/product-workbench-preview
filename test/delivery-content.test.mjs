import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDeliveryContent } from '../lib/delivery-content.mjs';

function fixture() {
  const executionId = 'v-11111111-1111-4111-8111-111111111111';
  const document = {
    features: {
      annotate: {
        rules: ['保存批注不改变完成状态'],
        dependencies: ['storage'],
        checks: ['保存后可读取原文', '冲突保留输入'],
        flow: [
          ['提交', '提交原文'],
          ['保存', '锁内保存'],
        ],
        stepDetails: [
          { rules: ['批注不改变完成状态'], dependencies: [], exception: '' },
          { rules: [], dependencies: ['storage'], exception: '版本冲突时保留输入' },
        ],
        sequence: {
          roles: ['人', '服务'],
          base: [[0, 1, '保存批注', 0]],
          normal: [[1, 0, '保存成功', 1]],
          failure: '冲突',
          error: [[1, 0, '冲突并保留输入', 1, 'error']],
        },
        implementation: { checks: [{ name: '批注存储测试', executionId }] },
      },
    },
    diagrams: {},
  };
  const review = {
    journeys: [
      {
        title: '提交批注',
        outcome: 'AI 可读取保存的修改意图',
        evidence: 'README 的批注协作入口',
        steps: [
          { featureId: 'annotate', step: 0 },
          { featureId: 'annotate', step: 1 },
        ],
      },
    ],
    features: [
      {
        id: 'annotate',
        outcome: 'implemented',
        content: { rules: { decision: 'included' }, dependencies: { decision: 'included' } },
        diagrams: {
          sequence: { decision: 'included' },
          dataflow: {
            decision: 'skipped',
            reason: '已有时序说明写入边界',
            alternative: { featureId: 'annotate', diagram: 'sequence' },
          },
        },
        acceptance: [
          {
            criterion: 0,
            scenario: 'normal',
            steps: [0, 1],
            executionId,
            evidence: 'annotation.test: 保存后读取原文且状态不变',
          },
          {
            criterion: 1,
            scenario: 'exception',
            steps: [1],
            executionId,
            evidence: 'annotation.test: 旧版本冲突保留输入',
          },
        ],
      },
    ],
  };
  return { document, review };
}
test('同一真实执行可以覆盖多个业务条件及正常异常路径，不要求重复运行', () => {
  const { document, review } = fixture();
  assert.deepEqual(checkDeliveryContent(document, review), []);
});
test('遗漏核心旅程、规则、步骤依赖及业务验收条件会被指出', () => {
  const { document, review } = fixture();
  review.journeys = [];
  document.features.annotate.rules = [];
  document.features.annotate.stepDetails[0].rules = [];
  document.features.annotate.stepDetails[1].dependencies = [];
  document.features.annotate.checks = [];
  const paths = checkDeliveryContent(document, review).map((gap) => gap.path);
  for (const path of [
    '/review/journeys',
    '/features/annotate/rules',
    '/features/annotate/dependencies',
    '/features/annotate/checks',
  ])
    assert.ok(paths.includes(path), path);
});
test('拒绝只有失败名称的时序图与引用不存在图表的跳过理由', () => {
  const { document, review } = fixture();
  document.features.annotate.sequence.error = [];
  review.features[0].diagrams.dataflow.alternative.diagram = 'dataflow';
  const paths = checkDeliveryContent(document, review).map((gap) => gap.path);
  assert.ok(paths.includes('/features/annotate/sequence/error'));
  assert.ok(paths.includes('/features/annotate/dataflow'));
});
test('全局回归命令未映射业务条件与异常路径时仍不具备完整交付依据', () => {
  const { document, review } = fixture();
  review.features[0].acceptance = [review.features[0].acceptance[0]];
  const paths = checkDeliveryContent(document, review).map((gap) => gap.path);
  assert.ok(paths.includes('/features/annotate/checks/1'));
  assert.ok(paths.includes('/features/annotate/stepDetails/1/exception'));
  review.features[0].acceptance[0].executionId = '另一功能的执行';
  assert.ok(
    checkDeliveryContent(document, review).some(
      (gap) => gap.path === '/features/annotate/acceptance',
    ),
  );
});
test('旅程中的无效步骤拒绝；确实无约束的功能可以有理由地跳过规则', () => {
  const { document, review } = fixture();
  review.journeys[0].steps.push({ featureId: 'missing', step: 0 });
  assert.ok(checkDeliveryContent(document, review).some((gap) => gap.path.endsWith('/steps')));
  review.journeys[0].steps.pop();
  document.features.annotate.rules = [];
  document.features.annotate.stepDetails[0].rules = [];
  review.features[0].content.rules = {
    decision: 'skipped',
    reason: '纯转换且没有额外业务约束，已检查实现',
  };
  assert.deepEqual(checkDeliveryContent(document, review), []);
});
test('损坏的旅程和替代引用返回缺口，不因对象编号转换而崩溃', () => {
  const { document, review } = fixture();
  review.journeys[0].steps.push({ featureId: { toString: null }, step: 0 });
  review.features.push({ id: { toString: null } });
  review.features[0].diagrams.dataflow.alternative = {
    featureId: { toString: null },
    diagram: 'sequence',
  };
  assert.equal(checkDeliveryContent(document, review).length, 2);
});
test('失败分支独有的步骤只要求异常验收，不伪造正常执行覆盖', () => {
  const { document, review } = fixture();
  const feature = document.features.annotate;
  feature.flow.push(['拒绝冲突', '保留输入']);
  feature.stepDetails[1].exception = '';
  feature.stepDetails.push({ rules: [], dependencies: [], exception: '冲突时保留输入' });
  feature.sequence.error = [[1, 0, '冲突并保留输入', 2, 'error']];
  review.features[0].acceptance[1].steps = [2];
  assert.deepEqual(checkDeliveryContent(document, review), []);
});
