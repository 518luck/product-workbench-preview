import { inventory } from './analysis-index.mjs';

// Compare against the same root with tool defaults, independently of AI filters.
export function scopeCoverage(state) {
  const source = new Set(['source', 'types', 'unsupported', 'unreadable']);
  const selected = new Set(state.manifest.filter((m) => source.has(m.kind)).map((m) => m.file));
  if (
    state.scope.include.length === 1 &&
    state.scope.include[0] === '.' &&
    !state.scope.exclude.length
  )
    return { full: true, selectedFiles: selected.size, totalFiles: selected.size, omitted: [] };
  const full = inventory(state.root, { contexts: state.scope.contexts || [] });
  const all = full.manifest.filter((m) => source.has(m.kind));
  const omitted = all
    .filter((m) => !selected.has(m.file))
    .map(({ file, kind, language }) => ({ file, kind, ...(language ? { language } : {}) }));
  return {
    full: omitted.length === 0,
    selectedFiles: selected.size,
    totalFiles: all.length,
    omitted,
    scope: '与同一项目根目录的默认自有源码清单比较；默认依赖与生成目录仍排除，文本上下文另行核对。',
  };
}
export const scopeGaps = (coverage) =>
  coverage.omitted.map((item) => ({
    kind: 'scope',
    path: `/scope/${item.file}`,
    file: item.file,
    message: '此自有源码被 include/exclude 排除；声明范围内读取完整不等于整个目标项目完整。',
  }));
