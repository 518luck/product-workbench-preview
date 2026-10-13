(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const paths = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20.5 13A8.7 8.7 0 0 1 11 3.5a9 9 0 1 0 9.5 9.5Z"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  const icon = (name, size = 18) =>
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:${size}px;height:${size}px">${paths[name] || ''}</svg>`;
  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const embeddedDocument = JSON.parse($('product-data').textContent);
  const features = [];
  const dependencies = [];
  const initial = {
    mode: 'business',
    view: 'feature',
    feature: Object.keys(embeddedDocument.features)[0] || '',
    dependency: embeddedDocument.dependencies?.[0]?.id || '',
    selectedStep: 0,
    diagramView: 'flow',
    projectDiagram: 'summary',
    sequenceCase: 'success',
  };
  let state = { ...initial };
  let productDocument = { features: {} };
  let documentAvailable = false;
  const descriptionEdits = new Map();
  const groupEdits = new Map();
  const titleEdits = new Map();
  let savingTitle = false;
  function updateTitleEditor() {
    const f = featureById(state.feature),
      field = $('feature-name');
    if (!field) return;
    const changed = field.value.trim() !== f.title.trim(),
      valid = field.value.trim().length > 0 && field.value.trim().length <= 80;
    $('feature-name-save').hidden = !changed && !savingTitle;
    $('feature-name-cancel').hidden = !changed && !savingTitle;
    $('feature-name-save').disabled = !documentAvailable || savingTitle || !changed || !valid;
    $('feature-name-cancel').disabled = savingTitle;
    $('feature-name-save').textContent = savingTitle ? '保存中…' : '保存名称';
    $('feature-name-status').textContent =
      changed && !valid ? '名称为 1–80 字' : changed ? '名称未保存' : '';
  }
  async function saveFeatureTitle() {
    const f = featureById(state.feature),
      title = $('feature-name').value;
    if (!title.trim() || title.trim().length > 80 || savingTitle || !documentAvailable) return;
    savingTitle = true;
    updateTitleEditor();
    try {
      const r = documentRecord(f),
        response = await fetch('/document/features/' + encodeURIComponent(f.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description: activeContent(f).description,
            expectedRevision: r?.revision ?? 0,
            expectedEditRevision: r?.editRevision ?? 0,
          }),
        });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '保存名称失败，请重试。');
      productDocument.features[f.id] = result;
      applyProductDocument(productDocument);
      if (titleEdits.get(f.id) === title) titleEdits.delete(f.id);
      if (state.feature === f.id && state.mode === 'business') render();
      toast('名称已保存。');
    } catch (error) {
      toast(error.message || '名称未保存，输入内容仍保留。');
    } finally {
      savingTitle = false;
      updateTitleEditor();
    }
  }
  const expandedGroups = new Map();
  const parseGroupPath = (value) =>
    String(value || '')
      .split(/[\/／>]/)
      .map((part) => part.trim())
      .filter(Boolean);
  const validGroupPath = (parts) => parts.length <= 5 && parts.every((part) => part.length <= 40);
  const featureGroups = (f) =>
    Array.isArray(documentRecord(f)?.groupPath) ? documentRecord(f).groupPath : [];
  const groupPathText = (f) => featureGroups(f).join(' / ');
  function groupOptions() {
    const paths = new Set();
    for (const f of documentFeatures()) {
      const parts = featureGroups(f);
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join(' / '));
    }
    return `<datalist id="feature-group-options">${[...paths].map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>`;
  }
  function openFeatureGroups(f) {
    const parts = [...featureGroups(f)];
    if (!parts.length) parts.push('未分组');
    for (let i = 1; i <= parts.length; i++)
      expandedGroups.set(JSON.stringify(parts.slice(0, i)), true);
  }
  function renderFeatureTree() {
    const tree = { groups: new Map(), features: [] };
    for (const f of documentFeatures()) {
      const parts = featureGroups(f).length ? featureGroups(f) : ['未分组'];
      let node = tree;
      for (const part of parts) {
        if (!node.groups.has(part))
          node.groups.set(part, { groups: new Map(), features: [], count: 0 });
        node = node.groups.get(part);
        node.count++;
      }
      node.features.push(f);
    }
    function branch(node, path = []) {
      const groups = [...node.groups]
        .map(([title, child]) => {
          const parts = [...path, title],
            key = JSON.stringify(parts),
            active =
              state.view === 'feature' &&
              JSON.stringify(
                (featureGroups(featureById(state.feature)).length
                  ? featureGroups(featureById(state.feature))
                  : ['未分组']
                ).slice(0, parts.length),
              ) === key;
          const open = expandedGroups.has(key)
            ? expandedGroups.get(key)
            : path.length === 0 || active;
          return `<details class="feature-group" data-feature-group="${esc(key)}" ${open ? 'open' : ''}><summary aria-label="分组 ${esc(parts.join(' / '))}"><span class="group-chevron" aria-hidden="true">›</span><span>${esc(title)}</span><small>${child.count}</small></summary><div class="feature-group-children">${branch(child, parts)}</div></details>`;
        })
        .join('');
      const leaves = node.features
        .map(
          (f) =>
            `<button type="button" class="nav-item feature-leaf ${state.view === 'feature' && state.feature === f.id ? 'active' : ''}" data-feature="${esc(f.id)}" ${state.view === 'feature' && state.feature === f.id ? 'aria-current="page"' : ''}><span>${esc(documentRecord(f)?.title || f.title)}</span><span class="nav-end nav-feature-status">${featureStatus(f)}</span></button>`,
        )
        .join('');
      return groups + leaves;
    }
    return `<div class="feature-tree">${branch(tree)}</div><button type="button" class="nav-item new-feature-nav" data-new-feature>＋ 新增功能</button>`;
  }
  function updateTreeControls() {
    const groups = [...$('navigation').querySelectorAll('details.feature-group')];
    $('tree-actions').hidden = state.mode !== 'business' || groups.length === 0;
    $('tree-expand').disabled = groups.length === 0 || groups.every((group) => group.open);
    $('tree-collapse').disabled = !groups.some((group) => group.open);
  }
  function setAllFeatureGroups(open) {
    for (const group of $('navigation').querySelectorAll('details.feature-group')) {
      expandedGroups.set(group.dataset.featureGroup, open);
      group.open = open;
    }
    updateTreeControls();
  }
  let savingDescription = false;
  let newFeatureDraft = { id: '', title: '', description: '', groupPathText: '' };
  let creatingFeature = false;
  function openNewFeature() {
    state.mode = 'business';
    state.view = 'new-feature';
    render();
    $('new-feature-title').focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function updateNewFeatureForm() {
    const button = $('new-feature-save');
    if (!button) return;
    button.disabled =
      !documentAvailable ||
      creatingFeature ||
      !newFeatureDraft.title.trim() ||
      !newFeatureDraft.description.trim() ||
      !validGroupPath(parseGroupPath(newFeatureDraft.groupPathText));
    button.textContent = creatingFeature ? '保存中…' : '保存草稿';
  }
  function renderNewFeature() {
    $('page').innerHTML =
      `<article class="journey-canvas new-feature-document"><div class="journey-head"><h2>新增功能</h2><span class="document-status">草稿</span></div><form id="new-feature-form"><label class="new-feature-label" for="new-feature-title">功能名称</label><input id="new-feature-title" aria-label="功能名称" type="text" required maxlength="80" placeholder="填写功能名称" value="${esc(newFeatureDraft.title)}"><div class="new-feature-group-field"><label class="new-feature-label" for="new-feature-group">所属分组</label><input id="new-feature-group" aria-label="所属分组" list="feature-group-options" maxlength="215" placeholder="模块 / 子模块；留空为未分组" value="${esc(newFeatureDraft.groupPathText)}">${groupOptions()}</div><section class="document-summary"><div class="document-editor-heading"><label for="new-feature-definition">功能定义</label></div><textarea id="new-feature-definition" aria-label="新功能定义" required maxlength="5000" rows="6" placeholder="写下这个功能应当怎样运转。">${esc(newFeatureDraft.description)}</textarea></section><div class="document-editor-actions"><button class="button" type="button" data-cancel-new-feature>取消</button><button class="button" id="new-feature-save" type="submit" disabled>保存草稿</button></div></form></article>`;
    updateNewFeatureForm();
  }
  async function createDocumentFeature() {
    if (
      creatingFeature ||
      !documentAvailable ||
      !newFeatureDraft.title.trim() ||
      !newFeatureDraft.description.trim() ||
      !validGroupPath(parseGroupPath(newFeatureDraft.groupPathText))
    )
      return;
    if (!newFeatureDraft.id) newFeatureDraft.id = 'new-' + crypto.randomUUID();
    const sent = { ...newFeatureDraft };
    creatingFeature = true;
    updateNewFeatureForm();
    try {
      const context = { title: sent.title.trim() };
      const response = await fetch('/document/features/' + encodeURIComponent(sent.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          create: true,
          description: sent.description,
          groupPath: parseGroupPath(sent.groupPathText),
          expectedRevision: 0,
          expectedEditRevision: 0,
          context,
        }),
      });
      const record = await response.json();
      if (!response.ok) throw new Error(record.error || '保存失败，请重试。');
      productDocument.features[sent.id] = record;
      applyProductDocument(productDocument);
      newFeatureDraft = { id: '', title: '', description: '', groupPathText: '' };
      state.diagramView = 'flow';
      setFeature(sent.id);
      toast('新功能已保存为草稿，等待 AI 梳理流程。');
    } catch (error) {
      toast(error.message || '保存失败，输入内容仍保留。');
    } finally {
      creatingFeature = false;
      updateNewFeatureForm();
    }
  }
  const documentRecord = (f) => productDocument.features[f.id];
  const featureStatus = (f) => {
    const r = documentRecord(f);
    return r && Number.isInteger(r.implementedRevision) && r.implementedRevision === r.revision
      ? '完成'
      : '草稿';
  };
  function applyProductDocument(doc) {
    productDocument = doc;
    features.splice(
      0,
      features.length,
      ...Object.entries(doc.features || {})
        .filter(
          ([, r]) =>
            r &&
            typeof r.title === 'string' &&
            typeof r.description === 'string' &&
            Array.isArray(r.flow) &&
            Array.isArray(r.rules),
        )
        .map(([id, r]) => ({
          actors: [],
          dependencies: [],
          checks: [],
          impact: [],
          overview: r.description,
          stepDetails: [],
          ...r,
          id,
        })),
    );
    dependencies.splice(0, dependencies.length, ...(doc.dependencies || []));
    if (!featureById(state.feature)) state.feature = features[0]?.id || '';
    if (!depById(state.dependency)) state.dependency = dependencies[0]?.id || '';
    if (!features.length) state.view = 'overview';
    const name = doc.product?.name || '产品蓝图';
    document.title = '产品蓝图 · ' + name;
    document.querySelector('.brand-name').textContent = name;
    document.querySelector('.breadcrumb strong').textContent = name;
    document.querySelector('meta[name="description"]').content =
      '用自然语言记录产品背景、功能流程、业务规则和系统依赖。';
  }
  async function loadProductDocument() {
    try {
      const response = await fetch('/product-document.json', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const doc = await response.json();
      if (!doc.features || typeof doc.features !== 'object') throw new Error();
      applyProductDocument(doc);
      documentAvailable = true;
    } catch {
      documentAvailable = false;
      toast('当前文档只能阅读，保存需要本机文档服务。');
    }
    render();
  }
  function updateDescriptionEditor() {
    const f = featureById(state.feature),
      field = $('feature-description');
    if (!field) return;
    const changed = field.value.trim() !== activeContent(f).description.trim(),
      parts = parseGroupPath($('document-group-path').value),
      groupChanged = JSON.stringify(parts) !== JSON.stringify(featureGroups(f)),
      needsSave = changed || groupChanged || !documentRecord(f),
      valid = validGroupPath(parts);
    $('document-save').disabled =
      !documentAvailable || savingDescription || !needsSave || !field.value.trim() || !valid;
    $('document-discard').disabled = savingDescription || !(changed || groupChanged);
    $('document-save-status').textContent = !valid
      ? '分组最多 5 层，每层不超过 40 字'
      : savingDescription
        ? '保存中…'
        : changed || groupChanged
          ? '未保存'
          : documentAvailable
            ? documentRecord(f)
              ? '已保存到项目文档'
              : '尚未保存到项目文档'
            : '项目文档暂不可保存';
    $('feature-status').textContent = changed ? '草稿 · 未保存' : featureStatus(f);
  }
  async function saveDescription() {
    const f = featureById(state.feature),
      description = $('feature-description').value,
      groupText = $('document-group-path').value,
      groupPath = parseGroupPath(groupText),
      definitionChanged = description.trim() !== activeContent(f).description.trim();
    if (
      !description.trim() ||
      savingDescription ||
      !documentAvailable ||
      !validGroupPath(groupPath)
    )
      return;
    savingDescription = true;
    updateDescriptionEditor();
    try {
      const r = documentRecord(f),
        response = await fetch('/document/features/' + encodeURIComponent(f.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description,
            groupPath,
            expectedRevision: r?.revision ?? 0,
            expectedEditRevision: r?.editRevision ?? 0,
          }),
        });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '保存失败，请重试。');
      productDocument.features[f.id] = result;
      applyProductDocument(productDocument);
      if (descriptionEdits.get(f.id) === description) descriptionEdits.delete(f.id);
      if (groupEdits.get(f.id) === groupText) groupEdits.delete(f.id);
      openFeatureGroups(f);
      if (state.feature === f.id && state.mode === 'business') render();
      toast(definitionChanged ? '定义已保存为草稿，流程等待 AI 梳理。' : '分组已保存。');
    } catch (error) {
      toast(error.message || '保存失败，输入内容仍保留。');
    } finally {
      savingDescription = false;
      updateDescriptionEditor();
    }
  }
  const featureById = (id) => features.find((f) => f.id === id);
  const depById = (id) => dependencies.find((d) => d.id === id);
  const activeContent = (feature) => documentRecord(feature) || feature;
  let toastTimer;
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
  }
  function setFeature(id) {
    if (!featureById(id)) return;
    state.mode = 'business';
    state.view = 'feature';
    state.feature = id;
    state.selectedStep = 0;
    state.sequenceCase = 'success';
    openFeatureGroups(featureById(id));
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function setDependency(id) {
    if (!depById(id)) return;
    state.mode = 'dependencies';
    state.view = 'dependencies';
    state.dependency = id;
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function navigate(mode) {
    state.mode = mode;
    state.view = mode === 'business' ? (features.length ? 'feature' : 'overview') : 'dependencies';
    render();
  }
  function renderNavigation() {
    $('business-tab').classList.toggle('active', state.mode === 'business');
    $('business-tab').setAttribute('aria-selected', state.mode === 'business');
    $('dependencies-tab').classList.toggle('active', state.mode === 'dependencies');
    $('dependencies-tab').setAttribute('aria-selected', state.mode === 'dependencies');
    $('workspace').setAttribute(
      'aria-labelledby',
      state.mode === 'business' ? 'business-tab' : 'dependencies-tab',
    );
    $('overview-button').classList.toggle('active', state.view === 'overview');
    $('overview-button').textContent = '产品概览';
    $('nav-label').textContent = state.mode === 'business' ? '功能目录' : '依赖目录';
    $('navigation').innerHTML =
      state.mode === 'business'
        ? renderFeatureTree()
        : dependencies
            .map(
              (d) =>
                `<button type="button" class="nav-item ${state.dependency === d.id && state.view === 'dependencies' ? 'active' : ''}" data-dependency="${d.id}"><span>${esc(d.name)}</span></button>`,
            )
            .join('');
    $('directory-scroll').setAttribute(
      'aria-label',
      state.mode === 'business' ? '功能目录' : '依赖目录',
    );
    updateTreeControls();
    $('breadcrumb-section').textContent =
      state.view === 'overview'
        ? '产品概览'
        : state.view === 'new-feature'
          ? '新增功能'
          : state.mode === 'business'
            ? '业务功能 / ' +
              [...featureGroups(featureById(state.feature)), featureById(state.feature).title].join(
                ' / ',
              )
            : '系统依赖';
  }
  function pageHead(eyebrow, title) {
    return `<div class="page-heading"><h1>${title}</h1></div>`;
  }
  function stepDetails(f, index) {
    return (
      documentRecord(f)?.stepDetails?.[index] || {
        actor: '待补充',
        description: f.flow[index]?.[1] || '',
        rules: [],
        dependencies: [],
        result: '',
        exception: '',
        interactions: [],
        acceptance: '',
      }
    );
  }
  function openStepDetails(index) {
    const f = featureById(state.feature),
      step = f.flow[index],
      detail = stepDetails(f, index);
    $('step-title').textContent = step[0];
    $('step-context').innerHTML =
      '<span class="badge green">步骤 ' +
      String(index + 1).padStart(2, '0') +
      '</span><span>' +
      esc(f.title) +
      '</span><span>由 ' +
      esc(detail.actor) +
      ' 处理</span>';
    $('step-content').innerHTML =
      `<p class="passport-description">${esc(detail.description)}</p><div class="passport-grid"><section class="passport-section"><h3>需要遵守的规则 <small>${detail.rules.length} 条</small></h3><ul class="passport-rules">${detail.rules.map((rule) => `<li><span>${esc(rule)}</span></li>`).join('')}</ul></section><section class="passport-section"><h3>依赖 <small>${detail.dependenciesPending ? '待确认' : detail.dependencies.length + ' 项'}</small></h3><div class="passport-dependencies">${detail.dependenciesPending ? '<p>依赖尚未确认。</p>' : ''}${detail.dependencies
        .map((id) => {
          const d = depById(id);
          return `<button type="button" data-dependency="${id}"><span><strong>${esc(d.name)}</strong><small>${esc(d.purpose || '')}</small></span>${icon('chevron', 12)}</button>`;
        })
        .join(
          '',
        )}</div></section><section class="passport-section"><h3>完成之后</h3><p>${esc(detail.result)}</p></section><section class="passport-section passport-warning"><h3>如果没能完成</h3><p>${esc(detail.exception)}</p></section></div><section class="passport-section passport-traces"><h3>系统之间怎样交互</h3><ol>${detail.interactions.map(([from, to, message]) => `<li><span>${esc(from === to ? from + '执行' : from + ' → ' + to)}</span><span>${esc(message)}</span></li>`).join('')}</ol></section><div class="passport-check"><span><strong>验收：</strong>${esc(detail.acceptance)}</span></div>`;
    $('step-modal').showModal();
  }
  function renderSharedSequence(f) {
    const model = documentRecord(f)?.sequence;
    if (!model) return '<div class="empty-state"><p>尚未记录时序交互。</p></div>';
    const failed = state.sequenceCase === 'failure',
      messages = [...model.base, ...(failed ? model.error || [] : model.normal || [])];
    if (!messages.length) return '<div class="empty-state"><p>尚未记录该情形的交互。</p></div>';
    const width = diagramWidth(),
      columns = model.roles.map((_, i) => ((i + 0.5) * width) / model.roles.length),
      start = 102,
      gap = 44,
      height = start + (messages.length - 1) * gap + 60,
      marker = `shared-seq-${f.id}`;
    if (width / model.roles.length < 120)
      return `<div class="sequence-toolbar"><span class="sequence-title">交互顺序</span>${model.failure ? `<label class="sequence-scenario">情形<select id="shared-sequence-case"><option value="success" ${!failed ? 'selected' : ''}>${esc(model.success || '正常流程')}</option><option value="failure" ${failed ? 'selected' : ''}>${esc(model.failure)}</option></select></label>` : ''}</div><ol class="sequence-compact">${messages.map(([from, to, label, step, kind], i) => `<li><button type="button" data-step="${step}" aria-label="交互 ${i + 1}：${esc(label)}"><span class="document-status">${i + 1} · ${esc(model.roles[from])} → ${esc(model.roles[to])}</span><strong>${esc(label)}</strong></button></li>`).join('')}</ol>`;
    const roles = model.roles
      .map(
        (role, i) =>
          `<line class="seq-lifeline" x1="${columns[i]}" y1="62" x2="${columns[i]}" y2="${height - 26}" stroke="var(--theme-soft-surface,#dcdcdc)" stroke-dasharray="4 5"/><rect class="seq-role-box" x="${columns[i] - Math.min(62, width / model.roles.length / 2 - 6)}" y="9" width="${Math.min(124, width / model.roles.length - 12)}" height="43" rx="0" fill="var(--theme-soft-surface,#f5f5f5)" stroke="var(--theme-soft-surface,#e3e3e3)"/><text x="${columns[i]}" y="35" text-anchor="middle" class="seq-role">${esc(role)}</text>`,
      )
      .join('');
    const arrows = messages
      .map(([from, to, label, step, kind], i) => {
        const x1 = columns[from],
          x2 = columns[to],
          y = start + i * gap,
          response = kind === 'return' || kind === 'error',
          error = kind === 'error',
          selected = step === state.selectedStep;
        const color = response ? 'var(--seq-return)' : 'var(--seq-request)',
          arrow = error ? 'error' : response ? 'return' : 'request',
          midpoint = from === to ? x1 : (x1 + x2) / 2;
        const route =
          from === to
            ? `M ${x1 + 4} ${y} H ${x1 + 48} V ${y + 16} H ${x1 + 6}`
            : `M ${x1 + (x2 > x1 ? 4 : -4)} ${y} H ${x2 + (x2 > x1 ? -7 : 7)}`;
        const width = label.length * 12 + 17;
        return `<g><text x="7" y="${y + 3}" class="seq-order">${String(i + 1).padStart(2, '0')}</text><path class="seq-connector ${response ? 'seq-return-line' : 'seq-request-line'}" d="${route}" fill="none" stroke="${color}" stroke-width="${selected ? 2.5 : 2}" vector-effect="non-scaling-stroke" ${response ? 'stroke-dasharray="7 5"' : ''} marker-end="url(#${marker}-${arrow})"/><rect x="${midpoint - width / 2}" y="${y - 26}" width="${width}" height="19" rx="0" fill="${selected ? 'var(--theme-soft-surface,#f3f3f3)' : 'var(--theme-paper,#ffffff)'}"/><text x="${midpoint}" y="${y - 12}" text-anchor="middle" class="seq-message ${error ? 'seq-error' : response ? 'seq-response' : ''}" ${selected ? 'font-weight="550"' : ''}>${esc(label)}</text></g>`;
      })
      .join('');
    const selectors = f.flow
      .map(
        (step, i) =>
          `<button type="button" class="sequence-step-button ${i === state.selectedStep ? 'active' : ''}" data-step="${i}" aria-label="步骤 ${String(i + 1).padStart(2, '0')}：${esc(step[0])}" aria-pressed="${i === state.selectedStep}" aria-controls="step-modal" aria-haspopup="dialog"><span>${String(i + 1).padStart(2, '0')}</span>${esc(step[0])}</button>`,
      )
      .join('');
    return `<div class="shared-sequence"><div class="sequence-toolbar"><span class="sequence-title">交互顺序</span>${model.failure ? `<label class="sequence-scenario">查看情形<select id="shared-sequence-case"><option value="success" ${!failed ? 'selected' : ''}>${esc(model.success || '正常流程')}</option>${model.failure ? `<option value="failure" ${failed ? 'selected' : ''}>${esc(model.failure)}</option>` : ''}</select></label>` : ''}</div><div class="sequence-step-nav" role="group" aria-label="选择步骤详情">${selectors}</div><div class="sequence-scroll" role="region" aria-label="时序图，可在窄屏横向滚动"><svg class="sequence-svg" style="width:${width}px;min-width:0" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${marker}-title"><title id="${marker}-title">${esc(f.title)}：${esc((failed ? model.failure : model.success) || '正常流程')}时序图</title><desc>横向每列是一个参与者，从上到下是发生顺序。点击上方步骤可查看规则和依赖，高亮消息对应选中步骤。</desc><defs><marker id="${marker}-request" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="6" refY="4" orient="auto"><path d="M1 1 7 4 1 7Z" fill="var(--seq-request)"/></marker><marker id="${marker}-return" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="6" refY="4" orient="auto"><path d="M1 1 7 4 1 7" fill="none" stroke="var(--seq-return)" stroke-width="1.6"/></marker><marker id="${marker}-error" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="6" refY="4" orient="auto"><path d="M1 1 7 4 1 7" fill="none" stroke="var(--seq-return)" stroke-width="1.6"/></marker></defs>${roles}${arrows}<text x="10" y="${height - 6}" class="seq-caption">时间向下推进 ↓ · 高亮消息对应选中步骤</text></svg></div><div class="sequence-legend"><span><i class="sequence-line"></i>请求或操作</span><span><i class="sequence-line return"></i>返回结果</span></div></div>`;
  }
  const diagramKinds = [
    { id: 'flow', name: '业务流程图' },
    { id: 'sequence', name: '时序图' },
    { id: 'dataflow', name: '数据流图' },
  ];
  const projectDiagramKinds = [
    { id: 'summary', name: '背景与功能' },
    { id: 'architecture', name: '系统架构图' },
    { id: 'entities', name: '数据关系图' },
  ];
  function activeDiagram() {
    return state.view === 'overview' ? state.projectDiagram : state.diagramView;
  }
  function graphModel(f) {
    const kind = activeDiagram();
    return kind === 'architecture'
      ? productDocument.diagrams?.architecture
      : kind === 'entities'
        ? productDocument.diagrams?.entities
        : documentRecord(f)?.dataflow;
  }
  function layoutMap(model, width) {
    const columns = Math.max(1, Math.min(3, Math.floor((width - 52) / 200))),
      gap = 38,
      nodeWidth = (width - 52 - gap * (columns - 1)) / columns,
      ranks = new Map(),
      incoming = new Map(model.nodes.map((n) => [n.id, 0]));
    const outgoing = new Map(model.nodes.map((n) => [n.id, []]));
    for (const e of model.edges) {
      if (e.from !== e.to && incoming.has(e.to) && outgoing.has(e.from)) {
        incoming.set(e.to, incoming.get(e.to) + 1);
        outgoing.get(e.from).push(e.to);
      }
    }
    const queue = model.nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
    queue.forEach((id) => ranks.set(id, 0));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const to of outgoing.get(id)) {
        ranks.set(to, Math.max(ranks.get(to) || 0, (ranks.get(id) || 0) + 1));
        incoming.set(to, incoming.get(to) - 1);
        if (incoming.get(to) === 0) queue.push(to);
      }
    }
    for (const n of model.nodes) if (!ranks.has(n.id)) ranks.set(n.id, 0);
    const groups = new Map();
    model.nodes.forEach((n) => {
      const rank = ranks.get(n.id);
      if (!groups.has(rank)) groups.set(rank, []);
      groups.get(rank).push(n);
    });
    let top = 20;
    const placed = new Map();
    for (const [rank, nodes] of [...groups].sort((a, b) => a[0] - b[0])) {
      const score = (n) => {
        const parents = model.edges
          .filter((e) => e.to === n.id)
          .map((e) => placed.get(e.from))
          .filter(Boolean);
        return parents.length
          ? parents.reduce((sum, p) => sum + p.x, 0) / parents.length
          : model.nodes.indexOf(n) * nodeWidth;
      };
      nodes.sort((a, b) => score(a) - score(b));
      for (let start = 0; start < nodes.length; start += columns) {
        const row = nodes.slice(start, start + columns),
          rowHeight = Math.max(...row.map((n) => (n.fields ? 82 + n.fields.length * 20 : 110)));
        const rowWidth = row.length * nodeWidth + (row.length - 1) * gap,
          left = (width - rowWidth) / 2;
        row.forEach((n, i) =>
          placed.set(n.id, {
            ...n,
            x: left + i * (nodeWidth + gap),
            y: top,
            w: nodeWidth,
            h: rowHeight,
          }),
        );
        top += rowHeight + 76;
      }
    }
    return { nodes: model.nodes.map((n) => placed.get(n.id)), height: Math.max(160, top - 56) };
  }
  function renderMap(f) {
    const model = graphModel(f),
      marker = 'map-tip-' + activeDiagram();
    if (!model || !model.nodes.length)
      return '<div class="empty-state"><p>尚未记录该图表。</p></div>';
    const width = diagramWidth(),
      layout = layoutMap(model, width),
      byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const edges = model.edges
      .map((e, i) => {
        const from = byId.get(e.from),
          to = byId.get(e.to);
        if (!from || !to) return '';
        let path, x, y;
        if (from.id === to.id) {
          x = from.x + from.w + 12;
          y = from.y + from.h / 2;
          path = `M${from.x + from.w} ${y - 12} H${x + 5} V${y + 12} H${from.x + from.w + 4}`;
        } else if (from.y === to.y) {
          const right = from.x < to.x,
            x1 = right ? from.x + from.w : from.x,
            x2 = right ? to.x : to.x + to.w;
          y = from.y + from.h / 2;
          path = `M${x1} ${y} H${x2 + (right ? -5 : 5)}`;
          x = (x1 + x2) / 2;
        } else {
          const down = from.y < to.y,
            startX = from.x + from.w / 2,
            startY = down ? from.y + from.h : from.y,
            endX = to.x + to.w / 2,
            endY = down ? to.y : to.y + to.h;
          const laneY = down ? endY - 20 - (i % 3) * 18 : endY + 20 + (i % 3) * 18;
          const hasMiddle = layout.nodes.some(
            (n) =>
              n.id !== from.id &&
              n.id !== to.id &&
              n.y > Math.min(from.y, to.y) &&
              n.y < Math.max(from.y, to.y),
          );
          if (hasMiddle || !down) {
            const gutter = i % 2 ? width - 10 : 10;
            const outY = startY + (down ? 24 : -24);
            path = `M${startX} ${startY} V${outY} H${gutter} V${laneY} H${endX} V${endY + (down ? -5 : 5)}`;
            x = (gutter + endX) / 2;
          } else {
            path = `M${startX} ${startY} V${laneY} H${endX} V${endY - 5}`;
            x = (startX + endX) / 2;
          }
          y = laneY;
        }
        return `<g><path d="${path}" fill="none" stroke="var(--theme-diagram-arrow)" stroke-width="1.5" ${e.dashed ? 'stroke-dasharray="5 4"' : ''} ${e.relation ? '' : `marker-end="url(#${marker})"`}/><rect x="${x - 10}" y="${y - 10}" width="20" height="18" fill="var(--paper)"/><text x="${x}" y="${y + 3}" text-anchor="middle">${i + 1}</text></g>`;
      })
      .join('');
    const mapPaths = [...edges.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]).join(''),
      mapLabels = edges.replace(/<path\b[^>]*\/>/g, '');
    const nodes = layout.nodes
      .map(
        (n) =>
          `<button type="button" class="map-node" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px" data-map-node="${esc(n.id)}" aria-label="查看：${esc(n.title)}" aria-haspopup="dialog"><span class="map-node-type">${esc(n.type || '')}</span><strong title="${esc(n.title)}">${esc(n.title)}</strong>${n.fields ? `<span class="map-fields">${n.fields.map((field) => `<span>${esc(field)}</span>`).join('')}</span>` : `<span class="map-subtitle">${esc(n.subtitle || '')}</span>`}</button>`,
      )
      .join('');
    const relations = model.edges
      .map(
        (e, i) =>
          `<tr><td>${i + 1}</td><td>${esc(byId.get(e.from)?.title || e.from)} → ${esc(byId.get(e.to)?.title || e.to)}</td><td>${esc(e.label || '')}</td></tr>`,
      )
      .join('');
    return `<div class="map-title">${esc(model.title)}</div><div class="graph-scroll"><div class="flow-graph map-canvas" style="width:${width}px;height:${layout.height}px"><svg class="graph-edges" viewBox="0 0 ${width} ${layout.height}" aria-hidden="true"><defs><marker id="${marker}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7" fill="var(--theme-diagram-arrow)"/></marker></defs>${mapPaths}${mapLabels}</svg>${nodes}</div></div>${relations ? `<table class="map-relations" aria-label="图表关系"><thead><tr><th>编号</th><th>连接</th><th>含义</th></tr></thead><tbody>${relations}</tbody></table>` : ''}`;
  }
  function openMapDetails(id) {
    const f = featureById(state.feature),
      model = graphModel(f),
      n = model?.nodes.find((n) => n.id === id);
    if (!n) return;
    const d = n.dependency ? depById(n.dependency) : null,
      kind = activeDiagram(),
      global = kind === 'architecture' || kind === 'entities';
    const rules = d ? [d.responsibility, d.failure].filter(Boolean) : n.rules || [];
    const featureLinks = d ? (d.relations || []).map(featureById).filter(Boolean) : [];
    const depLinks = (n.dependencies || []).map(depById).filter(Boolean);
    const links = n.fields
      ? n.fields.map((field) => `<p>${esc(field)}</p>`).join('')
      : featureLinks.length
        ? featureLinks
            .map(
              (item) =>
                `<button type="button" data-feature="${esc(item.id)}">${esc(item.title)} →</button>`,
            )
            .join('')
        : depLinks.length
          ? depLinks
              .map(
                (item) =>
                  `<button type="button" data-dependency="${esc(item.id)}">${esc(item.name)} →</button>`,
              )
              .join('')
          : '';
    $('step-title').textContent = n.title;
    $('step-context').innerHTML =
      `<span>${esc(n.type || '')}</span><span>${esc([...diagramKinds, ...projectDiagramKinds].find((k) => k.id === kind)?.name || '')}</span><span>${esc(global ? productDocument.product?.name || '整个项目' : f.title)}</span>`;
    $('step-content').innerHTML =
      `<p class="passport-description">${esc(d?.description || n.description || n.subtitle || '')}</p><div class="passport-grid">${rules.length ? `<section class="passport-section"><h3>${d ? '职责与故障影响' : '规则与关系'}</h3><ul class="passport-rules">${rules.map((rule) => `<li>${esc(rule)}</li>`).join('')}</ul></section>` : ''}${links ? `<section class="passport-section"><h3>${n.fields ? '包含的信息' : '关联范围'}</h3><div class="passport-dependencies">${links}</div></section>` : ''}</div>`;
    $('step-modal').showModal();
  }
  function renderBusinessWorkspace(f) {
    const content = activeContent(f),
      text = descriptionEdits.has(f.id) ? descriptionEdits.get(f.id) : content.description,
      r = documentRecord(f);
    const summary = `<section class="document-summary"><div class="document-editor-heading"><label for="feature-description">功能定义</label><span id="feature-status" class="document-status">${featureStatus(f)}</span></div><div class="document-group-field"><label for="document-group-path">所属分组</label><input id="document-group-path" aria-label="所属分组" list="feature-group-options" maxlength="215" value="${esc(groupEdits.has(f.id) ? groupEdits.get(f.id) : groupPathText(f))}" placeholder="模块 / 子模块；留空为未分组">${groupOptions()}</div><textarea id="feature-description" aria-label="功能定义" rows="4" maxlength="5000" placeholder="用自然语言写清楚：谁来使用、每一步做什么、遵守哪些规则、异常时怎么办。">${esc(text || '')}</textarea><div class="document-editor-actions"><span id="document-save-status" role="status"></span><button class="button" id="document-discard" data-document-discard type="button" disabled>撤销修改</button><button class="button" id="document-save" data-document-save type="button" disabled>保存定义</button></div></section>`;
    const stale = r && r.flowRevision !== r.revision;
    const heading = `<div class="flow-version-bar"><h3>业务流程</h3>${f.flow.length ? '<span class="flow-version-hint">点击节点查看详情</span>' : ''}</div>`;
    const flow = f.flow.length
      ? renderClickableFlow(f)
      : `<div class="empty-state"><p>尚未记录业务流程。</p></div>`;
    return (
      summary + (f.notes ? `<p class="document-note">${esc(f.notes)}</p>` : '') + heading + flow
    );
  }

  function documentFeatures() {
    return features;
  }
  function diagramWidth() {
    const page = $('page'),
      style = getComputedStyle(page);
    return Math.max(
      220,
      Math.floor(
        page.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          (state.view === 'feature' ? 42 : 0) -
          2,
      ),
    );
  }
  function renderClickableFlow(f) {
    const width = diagramWidth(),
      count = f.flow.length,
      columns = Math.max(1, Math.min(4, Math.floor((width - 24) / 190))),
      gap = 38,
      nodeWidth = (width - 24 - gap * (columns - 1)) / columns,
      nodeHeight = 126,
      rows = Math.ceil(count / columns),
      height = 24 + rows * nodeHeight + (rows - 1) * 48;
    const positions = f.flow.map((_, i) => {
      const row = Math.floor(i / columns),
        col = row % 2 ? columns - 1 - (i % columns) : i % columns;
      return { x: 12 + col * (nodeWidth + gap), y: 12 + row * (nodeHeight + 48), row };
    });
    const edges = positions
      .slice(1)
      .map((to, i) => {
        const from = positions[i];
        const path =
          from.row === to.row
            ? from.x < to.x
              ? `M${from.x + nodeWidth} ${from.y + nodeHeight / 2} H${to.x - 5}`
              : `M${from.x} ${from.y + nodeHeight / 2} H${to.x + nodeWidth + 5}`
            : `M${from.x + nodeWidth / 2} ${from.y + nodeHeight} V${to.y - 5}`;
        return `<path d="${path}" fill="none" stroke="var(--theme-diagram-arrow)" stroke-width="1.6" marker-end="url(#flow-tip)"/>`;
      })
      .join('');
    const nodes = f.flow
      .map((s, i) => {
        const d = stepDetails(f, i),
          p = positions[i];
        return `<button type="button" class="graph-node ${state.selectedStep === i ? 'selected' : ''}" style="left:${p.x}px;top:${p.y}px;width:${nodeWidth}px;height:${nodeHeight}px" data-step="${i}" aria-label="步骤 ${String(i + 1).padStart(2, '0')}：${esc(s[0])}" aria-haspopup="dialog"><span class="graph-node-head"><span class="mono">${i + 1}</span><span>${esc(d.actor)}</span></span><strong title="${esc(s[0])}">${esc(s[0])}</strong><span class="graph-node-copy">${esc(s[1])}</span><span class="graph-node-meta">${d.rules.length} 条规则 · ${d.dependenciesPending ? '依赖待确认' : d.dependencies.length + ' 项依赖'}</span></button>`;
      })
      .join('');
    const exception = stepDetails(f, state.selectedStep).exception;
    return `<div class="graph-scroll"><div class="flow-graph" style="width:${width}px;height:${height}px"><svg class="graph-edges" viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><marker id="flow-tip" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7" fill="var(--theme-diagram-arrow)"/></marker></defs>${edges}</svg>${nodes}</div></div>${exception ? `<p class="flow-exception">异常：${esc(exception)}</p>` : ''}`;
  }
  function renderJourney(f) {
    const kind = diagramKinds.find((k) => k.id === state.diagramView) || diagramKinds[0],
      unconfirmed = !f.flow.length;
    const tabs = `<div class="diagram-gallery-nav" role="group" aria-label="图表类型">${diagramKinds.map((k) => `<button class="diagram-tab ${state.diagramView === k.id ? 'active' : ''}" type="button" data-diagram="${k.id}" aria-pressed="${state.diagramView === k.id}">${k.name}</button>`).join('')}</div>`;
    let body =
      kind.id === 'flow'
        ? renderBusinessWorkspace(f)
        : unconfirmed
          ? `<div class="empty-state"><p>尚未记录该图表。</p></div>`
          : kind.id === 'sequence'
            ? renderSharedSequence(f)
            : renderMap(f);
    return `<section class="journey-canvas" aria-label="产品图表"><div class="journey-head feature-name-editor"><h2 aria-label="${esc(f.title)}"><input id="feature-name" aria-label="功能名称" class="feature-name-field" type="text" maxlength="80" value="${esc(titleEdits.has(f.id) ? titleEdits.get(f.id) : f.title)}" title="点击修改功能名称"></h2><button class="button" id="feature-name-save" type="button" data-save-feature-title hidden>保存名称</button><button class="button" id="feature-name-cancel" type="button" data-cancel-feature-title hidden>取消</button><span id="feature-name-status" class="document-status" role="status"></span></div>${tabs}<div id="diagram-body" data-diagram-kind="${kind.id}">${body}</div></section>`;
  }

  function pendingMarkup(feature) {
    const r = documentRecord(feature);
    return r && feature.flow.length && r.flowRevision !== r.revision
      ? `<div class="document-sync-note">定义已修改。以下图表仍对应上一版定义，等待 AI 梳理后同步。</div>`
      : '';
  }
  function renderFeature() {
    const f = featureById(state.feature);
    if (!f) {
      state.view = 'overview';
      render();
      return;
    }
    if (
      !Number.isInteger(state.selectedStep) ||
      state.selectedStep < 0 ||
      state.selectedStep >= f.flow.length
    )
      state.selectedStep = 0;
    $('page').innerHTML =
      `<div class="journey-layout"><article class="journey-document">${pendingMarkup(f)}${renderJourney(f)}</article></div>`;
    updateDescriptionEditor();
    updateTitleEditor();
  }

  function renderDependencies() {
    const d = depById(state.dependency);
    if (!d) {
      $('page').innerHTML = '<div class="empty-state"><p>尚未记录系统依赖。</p></div>';
      return;
    }
    const related = documentFeatures().filter(
      (f) => (d.relations || []).includes(f.id) || f.dependencies.includes(d.id),
    );
    const rows = related
      .map((f) => {
        const used = f.flow
          .filter((step, i) => stepDetails(f, i).dependencies.includes(d.id))
          .map((step) => step[0]);
        return `<tr><td><button class="dep-text-link" type="button" data-dep-feature="${esc(f.id)}">${esc(f.title)}</button><span class="dep-text-status">${featureStatus(f)}</span></td><td>${used.length ? esc(used.join('、')) : '未记录参与步骤'}</td></tr>`;
      })
      .join('');
    $('page').innerHTML =
      `<article class="dep-document" aria-label="${esc(d.name)}依赖详情"><header class="dep-document-head"><h1>${esc(d.name)}</h1>${d.category ? `<p>${esc(d.category)}</p>` : ''}</header><section><h2>作用与职责</h2>${d.responsibility ? `<p class="dep-responsibility">${esc(d.responsibility)}</p>` : ''}${d.description ? `<p>${esc(d.description)}</p>` : ''}${!d.responsibility && !d.description ? '<p>尚未记录用途。</p>' : ''}</section><section><h2>关联功能 <small>${related.length} 项</small></h2>${rows ? `<table class="dep-function-table" aria-label="依赖关联的功能和步骤"><thead><tr><th scope="col">功能</th><th scope="col">参与步骤</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>尚未确认关联功能。</p>'}</section><section><h2>故障影响</h2><p>${esc(d.failure || '尚未记录故障影响。')}</p></section>${d.openQuestions?.length ? `<section><h2>待确认事项</h2>${d.openQuestions.map((q) => `<p>${esc(q)}</p>`).join('')}</section>` : ''}</article>`;
  }

  function renderOverview() {
    const p = productDocument.product || {},
      tabs = `<div class="diagram-gallery-nav" role="group" aria-label="项目内容">${projectDiagramKinds.map((k) => `<button class="diagram-tab ${state.projectDiagram === k.id ? 'active' : ''}" type="button" data-project-diagram="${k.id}" aria-pressed="${state.projectDiagram === k.id}">${k.name}</button>`).join('')}</div>`;
    const groups = new Map();
    for (const f of documentFeatures()) {
      const name = featureGroups(f).join(' / ') || '未分组';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(f);
    }
    const summary = `<div class="content-grid"><article><p class="overview-intro">${esc(p.background || '尚未记录产品背景。')}</p><div class="section-heading"><h2>功能</h2></div><div class="overview-list">${[...groups].map(([name, items]) => `<section class="overview-group"><h3>${esc(name)}</h3>${items.map((f) => `<button class="overview-feature" type="button" data-feature="${esc(f.id)}"><div class="overview-feature-title">${esc(f.title)} <span class="document-status">${featureStatus(f)}</span></div><div class="overview-feature-description">${esc(f.overview || f.description)}</div></button>`).join('')}</section>`).join('')}</div></article>${p.actors?.length ? `<aside class="aside"><div class="aside-heading">谁在使用</div>${p.actors.map((actor) => `<div class="person-row">${esc(actor)}</div>`).join('')}</aside>` : ''}</div>`;
    $('page').innerHTML =
      pageHead('', esc(p.name || '产品蓝图')) +
      tabs +
      (state.projectDiagram === 'summary' ? summary : renderMap());
  }
  function render() {
    $('page').classList.toggle(
      'dependency-page',
      state.mode === 'dependencies' && state.view === 'dependencies',
    );
    $('page').classList.toggle(
      'journey-page',
      state.view === 'feature' && state.mode === 'business',
    );
    renderNavigation();
    if (state.view === 'new-feature') renderNewFeature();
    else if (state.view === 'overview') renderOverview();
    else if (state.mode === 'dependencies') renderDependencies();
    else renderFeature();
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-tree-open'))
      setAllFeatureGroups(button.dataset.treeOpen === 'true');
    else if (button.hasAttribute('data-save-feature-title')) saveFeatureTitle();
    else if (button.hasAttribute('data-cancel-feature-title')) {
      titleEdits.delete(state.feature);
      renderFeature();
    } else if (button.hasAttribute('data-document-save')) saveDescription();
    else if (button.hasAttribute('data-document-discard')) {
      descriptionEdits.delete(state.feature);
      groupEdits.delete(state.feature);
      renderFeature();
    } else if (button.dataset.feature) {
      $('step-modal').close();
      setFeature(button.dataset.feature);
    } else if (button.dataset.depFeature) {
      state.diagramView = 'flow';
      setFeature(button.dataset.depFeature);
    } else if (button.dataset.dependency) {
      $('step-modal').close();
      setDependency(button.dataset.dependency);
    } else if (button.dataset.mode) navigate(button.dataset.mode);
    else if (button.hasAttribute('data-new-feature')) openNewFeature();
    else if (button.hasAttribute('data-cancel-new-feature')) {
      if (!creatingFeature) {
        newFeatureDraft = { id: '', title: '', description: '', groupPathText: '' };
        state.view = features.length ? 'feature' : 'overview';
        render();
      }
    } else if (button.dataset.mapNode) openMapDetails(button.dataset.mapNode);
    else if (button.dataset.projectDiagram) {
      state.projectDiagram = button.dataset.projectDiagram;
      renderOverview();
    } else if (button.dataset.diagram) {
      state.diagramView = button.dataset.diagram;
      renderFeature();
    } else if (button.hasAttribute('data-step')) {
      state.selectedStep = Number(button.dataset.step);
      renderFeature();
      openStepDetails(state.selectedStep);
    } else if (button.dataset.close) $(button.dataset.close).close();
  });
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (el.id === 'feature-name') {
      titleEdits.set(state.feature, el.value);
      updateTitleEditor();
    } else if (el.id === 'new-feature-title') {
      newFeatureDraft.title = el.value;
      updateNewFeatureForm();
    } else if (el.id === 'new-feature-group') {
      newFeatureDraft.groupPathText = el.value;
      updateNewFeatureForm();
    } else if (el.id === 'new-feature-definition') {
      newFeatureDraft.description = el.value;
      updateNewFeatureForm();
    } else if (el.id === 'document-group-path') {
      groupEdits.set(state.feature, el.value);
      updateDescriptionEditor();
    } else if (el.id === 'feature-description') {
      descriptionEdits.set(state.feature, el.value);
      updateDescriptionEditor();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.id === 'feature-name') {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!$('feature-name-save').disabled) saveFeatureTitle();
      } else if (event.key === 'Escape') {
        titleEdits.delete(state.feature);
        renderFeature();
      }
    }
  });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'shared-sequence-case') {
      state.sequenceCase = event.target.value;
      renderFeature();
    }
  });
  document.addEventListener(
    'toggle',
    (event) => {
      if (event.target.isConnected && event.target.classList?.contains('feature-group')) {
        expandedGroups.set(event.target.dataset.featureGroup, event.target.open);
        updateTreeControls();
      }
    },
    true,
  );
  document.addEventListener('submit', (event) => {
    if (event.target.id === 'new-feature-form') {
      event.preventDefault();
      createDocumentFeature();
    }
  });
  $('overview-button').addEventListener('click', () => {
    state.mode = 'business';
    state.view = 'overview';
    render();
  });
  $('step-modal').addEventListener('click', (e) => {
    if (e.target === $('step-modal')) {
      const box = e.target.getBoundingClientRect();
      if (
        e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom
      )
        e.target.close();
    }
  });
  document
    .querySelectorAll('.icon-button[data-close]')
    .forEach((button) => (button.innerHTML = icon('close', 17)));
  function renderThemeToggle() {
    const dark = document.documentElement.dataset.theme === 'dark',
      button = $('theme-toggle');
    button.innerHTML = icon(dark ? 'sun' : 'moon', 16);
    button.setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题');
    button.title = (dark ? '当前为深色' : '当前为浅色') + '，点击切换';
  }
  $('theme-toggle').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('product-workbench-theme', theme);
    } catch {}
    renderThemeToggle();
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view === 'feature') renderFeature();
      else if (state.view === 'overview' && state.projectDiagram !== 'summary') renderOverview();
    }, 100);
  });
  renderThemeToggle();
  applyProductDocument(embeddedDocument);
  render();
  loadProductDocument();
})();
