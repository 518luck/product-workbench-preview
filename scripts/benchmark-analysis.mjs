import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createIndexedState } from '../lib/analysis-database.mjs';
import { readAnalysisState } from '../lib/analysis-store.mjs';
import { scanAnalysis } from '../lib/analysis-session.mjs';

// Storage/index microbenchmark only: synthetic payloads are not AI analysis or
// proof of correct business understanding. No model or user project is touched.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-analysis-benchmark-'));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  const state = {
    version: 2,
    editRevision: 0,
    units: Array.from({ length: 300 }, (_, i) => ({
      id: 'u' + i,
      file: `file-${i}.ts`,
      name: `function${i}`,
      reviewPoints: Array.from({ length: 80 }, (_, p) => ({
        id: `p${i}-${p}`,
        kind: 'call',
        code: 'source-fragment-'.repeat(25),
      })),
      calls: [],
    })),
    facts: { values: [], edges: [] },
    receipts: {},
    records: Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        'r' + i,
        { responsibility: 'synthetic storage payload '.repeat(80) },
      ]),
    ),
    traces: {},
  };
  const legacy = path.join(root, 'legacy'),
    rows = path.join(root, 'rows');
  fs.mkdirSync(legacy);
  fs.mkdirSync(rows);
  fs.writeFileSync(path.join(legacy, 'state.json'), JSON.stringify(state));
  createIndexedState(path.join(rows, 'state.json'), state);
  const timings = { journal: [], sqlite: [] };
  let rowReads;
  for (let iteration = 0; iteration < 7; iteration++)
    for (const [type, folder] of [
      ['journal', legacy],
      ['sqlite', rows],
    ]) {
      const started = performance.now();
      const loaded = readAnalysisState(path.join(folder, 'state.json'));
      if (loaded.state.units[0].name !== 'function0' || !loaded.state.records.r0)
        throw Error('benchmark input mismatch');
      timings[type].push(performance.now() - started);
      if (type === 'sqlite') rowReads = loaded.storage.stats;
    }
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  for (let f = 0; f < 100; f++)
    fs.writeFileSync(
      path.join(project, `module-${f}.mjs`),
      Array.from(
        { length: 4 },
        (_, n) => `export function value${n}(input){return input+${f * 4 + n}}`,
      ).join('\n'),
    );
  const started = performance.now(),
    cold = await scanAnalysis(project),
    coldMs = performance.now() - started;
  const warmStart = performance.now(),
    warm = await scanAnalysis(project),
    warmMs = performance.now() - warmStart;
  fs.appendFileSync(path.join(project, 'module-0.mjs'), '\n// a local edit');
  const changedStart = performance.now(),
    changed = await scanAnalysis(project),
    changedMs = performance.now() - changedStart;
  const report = {
    scope: '本机合成存储/索引微基准，不是大型项目或实际 AI 初始化耗时承诺。',
    storage: {
      baseBytes: fs.statSync(path.join(legacy, 'state.json')).size,
      medianMs: { journal: median(timings.journal), sqlite: median(timings.sqlite) },
      samplesMs: timings,
      rowReads,
    },
    index: {
      files: 100,
      units: cold.unitCount,
      coldMs,
      warmMs,
      changedMs,
      warmIndexRebuilt: warm.indexRebuilt,
      invalidatedFiles: changed.reuse.invalidatedFiles.length,
    },
    limitations: [
      '源码变化后机器索引仍会重建；本轮增量复用的是未受影响且已核验的函数分析。',
      '首次完整源码阅读与实际模型耗时未在此测量。',
    ],
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
