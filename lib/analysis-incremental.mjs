import path from 'node:path';
import ts from 'typescript';
import { digest } from './analysis-facts.mjs';
import { languageFor } from './analysis-adapters.mjs';

export function dependencyProfile(input, indexed, program) {
  const files = Object.fromEntries(
    input.manifest
      .filter((f) => f.kind === 'source')
      .map((f) => [
        f.file,
        { hash: f.hash, language: languageFor(f.file), dependencies: [], conservative: false },
      ]),
  );
  const units = new Map(indexed.units.map((u) => [u.id, u]));
  const add = (file, target) => {
    if (files[file] && files[target] && file !== target) files[file].dependencies.push(target);
  };
  for (const imported of indexed.imports || []) {
    for (const target of [imported.target, ...(imported.targets || [])].filter(Boolean))
      add(imported.file, target);
    // Resolve provenance, not the local alias: loader.import_module() must
    // invalidate just as importlib.import_module() does. Missing relative
    // targets can also hide a project dependency from the reverse graph.
    if (
      files[imported.file]?.language === 'python' &&
      (/^(?:importlib|pkgutil|runpy)(?:\.|$)/.test(imported.module || '') ||
        (imported.module === 'builtins' && imported.name === '__import__') ||
        (imported.level > 0 && !imported.target && !imported.targets?.length))
    )
      files[imported.file].conservative = true;
  }
  for (const unit of indexed.units)
    for (const call of unit.calls || []) {
      for (const id of [call.target, ...(call.candidateTargets || [])].filter(Boolean))
        add(unit.file, units.get(id)?.file);
      if (/^(?:eval|require|import|__import__|importlib\.)/.test(call.expression))
        if (files[unit.file]) files[unit.file].conservative = true;
    }
  for (const [file, item] of Object.entries(files)) {
    if (item.language === 'javascript') {
      const source = program?.getSourceFile(path.join(input.root, file));
      const explicit = source?.statements.some(
        (node) =>
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isExportAssignment(node) ||
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
      );
      if (!source || (!explicit && !/\.(?:mjs|mts)$/.test(file))) item.conservative = true;
    }
    // Package members share Go declarations. C++ linkage/macros can cross TUs
    // without a resolved body; retain conservative invalidation for that boundary.
    if (item.language === 'go')
      for (const [other, candidate] of Object.entries(files))
        if (candidate.language === 'go' && path.posix.dirname(other) === path.posix.dirname(file))
          add(file, other);
    if (item.language === 'cpp' || item.language === 'go') item.conservative = true;
    item.dependencies = [...new Set(item.dependencies)].sort();
  }
  for (const gap of indexed.gaps || [])
    if (gap.language)
      for (const item of Object.values(files))
        if (item.language === gap.language) item.conservative = true;
  return {
    version: 1,
    environment: digest(
      JSON.stringify([
        input.scope,
        input.analyzers,
        input.manifest.filter(
          (f) =>
            f.kind !== 'source' &&
            ['types', 'context', 'unsupported', 'unreadable'].includes(f.kind),
        ),
      ]),
    ),
    files,
  };
}

export function invalidatedFiles(previous, next) {
  if (!previous || previous.version !== 1 || previous.environment !== next.environment)
    return {
      files: Object.keys(next.files),
      reasons: ['分析规则、类型、上下文或范围变化，保守重核全部单元。'],
    };
  const all = { ...previous.files, ...next.files },
    changed = new Set();
  for (const file of Object.keys(all))
    if (
      previous.files[file]?.hash !== next.files[file]?.hash ||
      JSON.stringify(previous.files[file]?.dependencies) !==
        JSON.stringify(next.files[file]?.dependencies)
    )
      changed.add(file);
  const changedLanguages = new Set([...changed].map((f) => all[f].language));
  for (const [file, item] of Object.entries(all))
    if (item.conservative && changedLanguages.has(item.language)) changed.add(file);
  // A global script/unknown dependency can affect any same-language consumer.
  for (const language of changedLanguages)
    if (Object.values(all).some((f) => f.language === language && f.conservative))
      for (const [file, item] of Object.entries(all))
        if (item.language === language) changed.add(file);
  for (let size = -1; size !== changed.size;) {
    size = changed.size;
    for (const file of Object.keys(all))
      if (
        [
          ...(previous.files[file]?.dependencies || []),
          ...(next.files[file]?.dependencies || []),
        ].some((dep) => changed.has(dep))
      )
        changed.add(file);
  }
  return {
    files: [...changed].sort(),
    reasons: ['源码、导入和已解析调用的反向依赖闭包；动态、全局及未解析的语言关系保守扩大。'],
  };
}
