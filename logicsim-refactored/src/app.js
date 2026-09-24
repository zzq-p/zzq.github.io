(function () {
  'use strict';
  const $id = id => document.getElementById(id);
  const core = window.LogicCore;
  const graph = new joint.dia.Graph({}, { cellNamespace: joint.shapes });
  const viewport = $id('viewport');
  const paper = new joint.dia.Paper({
    el: $id('paper'), model: graph, width: 800, height: 600, gridSize: 10,
    drawGrid: true, background: { color: '#f5f8fa' },
    cellViewNamespace: joint.shapes, interactive: { linkMove: false }, linkPinning: false,
    defaultLink: () => new joint.shapes.standard.Link({ attrs: { line: { stroke: '#728a98', strokeWidth: 1.5 } }, connector: { name: 'rounded' } }),
    validateMagnet: (_view, magnet) => magnet.getAttribute('port-group') === 'out',
    validateConnection: (source, sourceMagnet, target, targetMagnet) => {
      if (!sourceMagnet || !targetMagnet || source === target || sourceMagnet.getAttribute('port-group') !== 'out' || targetMagnet.getAttribute('port-group') !== 'in') return false;
      const port = targetMagnet.getAttribute('port');
      if (graph.getConnectedLinks(target.model, { inbound: true }).some(link => link.target().port === port)) return false;
      return !graph.getSuccessors(target.model).some(cell => cell.id === source.model.id);
    },
    defaultConnectionPoint: { name: 'boundary' }
  });
  const mini = new joint.dia.Paper({
    el: $id('mini-paper'), model: graph, width: 246, height: 145,
    cellViewNamespace: joint.shapes, interactive: false
  });
  let selected = null;
  let scale = 1;
  let importing = false;
  let frame = 0;
  const appearance = {
    '0': ['#b56536', 'zero.svg'], '1': ['#187b70', 'one.svg'],
    Import: ['#346b9b', 'input.svg'], Export: ['#755693', 'output.svg'], SEL: ['#d6e8e4', 'SEL.svg']
  };

  function status(message, error = false) {
    $id('status').textContent = message;
    $id('status').dataset.error = String(error);
  }
  function action(fn) {
    return async () => {
      try { await fn(); }
      catch (error) { status(error.message || '操作失败，请检查输入。', true); }
    };
  }
  function on(id, fn) { $id(id).addEventListener('click', action(fn)); }
  function portGroup(side) {
    return {
      position: { name: side },
      attrs: { portBody: { r: 4, fill: '#587080', stroke: '#fff', magnet: side === 'right' ? true : 'passive' }, portLabel: { fontSize: 10, fill: '#355264' } },
      markup: [{ tagName: 'circle', selector: 'portBody' }],
      label: { position: { name: side === 'left' ? 'right' : 'left', args: { y: 0 } }, markup: [{ tagName: 'text', selector: 'portLabel' }] }
    };
  }
  function makeNode(node) {
    const [color, icon] = appearance[node.type];
    const textColor = node.type === 'SEL' ? '#244840' : '#fff';
    const groups = core.PORTS[node.type];
    return new joint.shapes.standard.Rectangle({
      id: node.key, nodeData: node, position: node.position || { x: 0, y: 0 }, size: { width: 126, height: 104 },
      attrs: {
        body: { fill: color, rx: 8, ry: 8, stroke: '#fff', strokeWidth: 2 },
        label: { text: node.label || node.type, fill: textColor, fontSize: 12, fontWeight: 600, refY: 16 },
        icon: { 'xlink:href': `assets/${icon}`, x: 45, y: 30, width: 36, height: 36 },
        name: { text: node.name || '', fill: textColor, fontSize: 12, textAnchor: 'middle', x: 63, y: 86, textWrap: { width: 114, height: 24, ellipsis: true } }
      },
      markup: [{ tagName: 'rect', selector: 'body' }, { tagName: 'text', selector: 'label' }, { tagName: 'image', selector: 'icon' }, { tagName: 'text', selector: 'name' }],
      ports: { groups: { in: portGroup('left'), out: portGroup('right') }, items: [
        ...groups.input.map(id => ({ id, group: 'in', attrs: { portLabel: { text: id } } })),
        ...groups.output.map(id => ({ id, group: 'out', attrs: { portLabel: { text: id } } }))
      ] }
    });
  }
  function makeLink(link) {
    return new joint.shapes.standard.Link({
      source: { id: link.from, port: link.frompid }, target: { id: link.to, port: link.topid },
      attrs: { line: { stroke: '#728a98', strokeWidth: 1.5 } },
      router: { name: 'manhattan', args: { step: 20, startDirections: ['right'], endDirections: ['left'] } },
      connector: { name: 'rounded', args: { radius: 8 } }
    });
  }
  function exportModel() {
    return core.validateModel({
      nodeArray: graph.getElements().map(cell => ({ ...cell.get('nodeData'), key: String(cell.id), position: cell.position() })),
      linkArray: graph.getLinks().map(cell => ({ from: cell.source().id, frompid: cell.source().port, to: cell.target().id, topid: cell.target().port }))
    });
  }
  function syncText() { $id('model').value = JSON.stringify(exportModel(), null, 2); }
  function select(cell) {
    if (selected) selected.attr('body/stroke', '#fff');
    selected = cell;
    $id('inspector').disabled = !cell;
    $id('selection').textContent = cell ? `类型：${cell.get('nodeData').type} · 编号：${cell.id}` : '点击图中的节点查看和编辑';
    $id('node-name').value = cell ? cell.get('nodeData').name || '' : '';
    $id('node-memo').value = cell ? cell.get('nodeData').memo || '' : '';
    if (cell) cell.attr('body/stroke', '#f1af3a');
  }
  function fitPaper(target, width, height, padding, maximum) {
    const bounds = graph.getBBox(graph.getElements());
    if (!bounds) { target.scale(1); target.translate(0, 0); return 1; }
    const next = Math.min(maximum, Math.max(.01, Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height)));
    target.scale(next);
    target.translate((width - bounds.width * next) / 2 - bounds.x * next, (height - bounds.height * next) / 2 - bounds.y * next);
    return next;
  }
  function updateMini() { fitPaper(mini, $id('minimap').clientWidth, 145, 12, 1); }
  function showScale() { $id('zoom').textContent = `${Math.round(scale * 100)}%`; }
  function fit() {
    scale = fitPaper(paper, viewport.clientWidth, viewport.clientHeight, 55, 1.4);
    showScale(); updateMini();
  }
  function arrange() {
    joint.layout.DirectedGraph.layout(graph, { setLinkVertices: false, nodeSep: 50, rankSep: 85, edgeSep: 20, rankDir: 'LR', marginX: 40, marginY: 40 });
  }
  function refresh() {
    frame = 0;
    const count = graph.getElements().length;
    $id('counts').textContent = `${count} 个节点 · ${graph.getLinks().length} 条连线`;
    $id('empty').hidden = count > 0;
    updateMini();
  }
  function loadModel(input) {
    // Validate and construct before replacing the current graph.
    const model = core.validateModel(input);
    const cells = [...model.nodeArray.map(makeNode), ...model.linkArray.map(makeLink)];
    const previous = graph.getCells();
    const previousSelection = selected;
    try {
      graph.resetCells(cells);
      if (!model.nodeArray.every(node => node.position)) arrange();
      select(null); syncText(); refresh(); fit();
    } catch (error) {
      graph.resetCells(previous);
      select(previousSelection); refresh(); fit();
      throw error;
    }
  }
  function generate(draw) {
    const result = core.compile($id('expression').value);
    if (draw) loadModel(result.model);
    else $id('model').value = JSON.stringify(result.model, null, 2);
    const stats = result.stats;
    status(`${draw ? '已生成逻辑图' : '已解析到 JSON，点击“文本转图”载入'}：${stats.variables} 个变量，简化后 ${stats.decisions} 个选择节点。`);
  }
  function zoom(factor, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    const next = Math.min(3, Math.max(.01, scale * factor));
    const translation = paper.translate(), ratio = next / scale;
    paper.scale(next);
    paper.translate(x - (x - translation.tx) * ratio, y - (y - translation.ty) * ratio);
    scale = next; showScale();
  }
  on('generate', () => generate(true));
  on('parse', () => generate(false));
  on('load', () => { loadModel(core.parseModel($id('model').value)); status('已载入模型。'); });
  on('serialize', () => { syncText(); status('已将当前图形写入 JSON。'); });
  on('fit', fit);
  on('zoom-in', () => zoom(1.2));
  on('zoom-out', () => zoom(1 / 1.2));
  on('layout', () => { arrange(); fit(); syncText(); status('已重新布局。'); });
  on('update', () => {
    if (!selected) return;
    const data = { ...selected.get('nodeData'), name: $id('node-name').value, memo: $id('node-memo').value };
    selected.set('nodeData', data);
    selected.attr('name/text', data.name);
    syncText(); status('名称和备注已更新，节点类型保持不变。');
  });
  on('delete', () => {
    if (!selected) return;
    const cell = selected;
    select(null); cell.remove(); syncText(); status('已删除节点及其关联连线。');
  });
  on('download', () => {
    syncText();
    const url = URL.createObjectURL(new Blob([$id('model').value], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'logicsim-model.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('已导出当前图形，包含名称、备注和节点位置。');
  });
  on('import', () => { if (!importing) $id('file').click(); });
  $id('file').addEventListener('change', action(async () => {
    const file = $id('file').files[0];
    if (!file || importing) return;
    importing = true; $id('import').disabled = true;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件不能超过 2 MB。');
      const model = core.parseModel(await file.text());
      loadModel(model); status(`已载入 ${file.name}。`);
    } finally { importing = false; $id('import').disabled = false; $id('file').value = ''; }
  }));
  $id('expression').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault(); action(() => generate(true))();
    }
  });
  paper.on('element:pointerclick', view => select(view.model));
  paper.on('link:connect', view => {
    try { syncText(); status('连线已添加。'); }
    catch (error) { view.model.remove(); status(error.message, true); }
  });
  paper.on('link:mouseenter', view => view.addTools(new joint.dia.ToolsView({ tools: [new joint.linkTools.Remove()] })));
  paper.on('link:mouseleave', view => view.removeTools());
  paper.on('blank:pointerclick', () => select(null));
  let pan = null;
  paper.on('blank:pointerdown', event => {
    if (event.button !== 0) return;
    const translation = paper.translate();
    pan = { x: event.clientX, y: event.clientY, ...translation };
    viewport.style.cursor = 'grabbing';
  });
  window.addEventListener('pointermove', event => {
    if (pan) paper.translate(pan.tx + event.clientX - pan.x, pan.ty + event.clientY - pan.y);
  });
  function endPan() { pan = null; viewport.style.cursor = 'grab'; }
  window.addEventListener('pointerup', endPan);
  window.addEventListener('pointercancel', endPan);
  window.addEventListener('blur', endPan);
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .002), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  graph.on('add remove reset change:position', () => { if (!frame) frame = requestAnimationFrame(refresh); });
  new ResizeObserver(() => {
    paper.setDimensions(viewport.clientWidth, viewport.clientHeight);
    mini.setDimensions($id('minimap').clientWidth, 145);
    fit();
  }).observe(viewport);
  refresh();
})();
