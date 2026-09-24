(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LogicCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({ tokens: 512, variables: 64, decisions: 4096, operations: 50000, nodes: 2000, links: 6000 });
  const PORTS = Object.freeze({
    '0': { input: [], output: ['OUT'] }, '1': { input: [], output: ['OUT'] },
    Import: { input: [], output: ['OUT'] }, Export: { input: ['OUT'], output: [] },
    SEL: { input: ['SI', '0', '1'], output: ['SO', 'N', 'P'] }
  });
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function fail(message) { throw new Error(message); }

  function tokenize(expression) {
    if (typeof expression !== 'string' || !expression.trim()) fail('请输入逆波兰逻辑表达式。');
    if (expression.length > 20000) fail('表达式过长，请拆分后再试。');
    const tokens = expression.trim().split(/\s+/u);
    if (tokens.length > LIMITS.tokens) fail(`表达式最多支持 ${LIMITS.tokens} 个词元。`);
    let depth = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (['.', ',', '<', '>', '='].includes(token)) {
        const arity = token === '<' ? 1 : 2;
        if (depth < arity) fail(`第 ${index + 1} 项“${token}”需要 ${arity} 个操作数。`);
        depth = depth - arity + 1;
      } else {
        if (/[.,<>=]/u.test(token)) fail(`“${token}”包含运算符，请用空格分隔变量和运算符。`);
        if (token.length > 80) fail('变量名最多支持 80 个字符。');
        depth++;
      }
    }
    if (depth !== 1) fail(`表达式剩余 ${depth} 个结果，请检查是否缺少运算符。`);
    return tokens;
  }

  // Reduced ordered binary decision diagram: shared branches are computed once.
  // Variable order follows first appearance; size/work caps bound difficult inputs.
  function compile(expression) {
    const tokens = tokenize(expression);
    const operators = new Set(['.', ',', '<', '>', '=']);
    const variables = [...new Set(tokens.filter(t => !operators.has(t) && t !== '0' && t !== '1'))];
    if (variables.length > LIMITS.variables) fail(`最多支持 ${LIMITS.variables} 个不同变量。`);
    const ranks = new Map(variables.map((name, index) => [name, index]));
    const decisions = [null, null];
    const unique = new Map();
    const memo = new Map();
    let work = 0;
    function make(rank, low, high) {
      if (low === high) return low;
      const key = `${rank}:${low}:${high}`;
      if (unique.has(key)) return unique.get(key);
      if (decisions.length - 2 >= LIMITS.decisions) fail('逻辑图过于复杂，请拆分表达式或调整变量顺序。');
      const id = decisions.length;
      decisions.push({ rank, low, high });
      unique.set(key, id);
      return id;
    }
    function apply(operator, left, right) {
      const key = `${operator}:${left}:${right}`;
      if (memo.has(key)) return memo.get(key);
      if (++work > LIMITS.operations) fail('计算量超出限制，请拆分表达式。');
      if (left < 2 && right < 2) {
        const a = Boolean(left), b = Boolean(right);
        return Number(operator === '.' ? a && b : operator === ',' ? a || b : operator === '>' ? !a || b : a === b);
      }
      const l = decisions[left], r = decisions[right];
      const rank = Math.min(l ? l.rank : Infinity, r ? r.rank : Infinity);
      const low = apply(operator, l && l.rank === rank ? l.low : left, r && r.rank === rank ? r.low : right);
      const high = apply(operator, l && l.rank === rank ? l.high : left, r && r.rank === rank ? r.high : right);
      const result = make(rank, low, high);
      memo.set(key, result);
      return result;
    }
    const stack = [];
    for (const token of tokens) {
      if (operators.has(token)) {
        const right = stack.pop();
        stack.push(token === '<' ? apply('=', right, 0) : apply(token, stack.pop(), right));
      } else stack.push(token === '0' || token === '1' ? Number(token) : make(ranks.get(token), 0, 1));
    }
    const root = stack[0];
    const reachable = new Set();
    function visit(id) {
      if (id < 2 || reachable.has(id)) return;
      reachable.add(id);
      visit(decisions[id].low);
      visit(decisions[id].high);
    }
    visit(root);
    const usedRanks = [...new Set([...reachable].map(id => decisions[id].rank))].sort((a, b) => a - b);
    const nodeArray = [
      { key: 'const:0', type: '0', name: 'Zero' },
      { key: 'const:1', type: '1', name: 'One' },
      { key: 'output', type: 'Export', name: 'Out' },
      ...usedRanks.map(rank => ({ key: `input:${rank}`, type: 'Import', name: variables[rank] }))
    ];
    const linkArray = [];
    const keyOf = id => id < 2 ? `const:${id}` : `decision:${id}`;
    function connect(from, to, topid) {
      linkArray.push({ from: keyOf(from), frompid: from < 2 ? 'OUT' : 'N', to, topid });
    }
    for (const id of reachable) {
      const node = decisions[id], key = keyOf(id);
      nodeArray.push({ key, type: 'SEL', name: variables[node.rank] });
      linkArray.push({ from: `input:${node.rank}`, frompid: 'OUT', to: key, topid: 'SI' });
      connect(node.low, key, '0');
      connect(node.high, key, '1');
    }
    connect(root, 'output', 'OUT');
    const model = validateModel({ nodeArray, linkArray });
    return { model, stats: { variables: variables.length, usedVariables: usedRanks.length, decisions: reachable.size, operations: work } };
  }

  function validateModel(input) {
    if (!input || !Array.isArray(input.nodeArray) || !Array.isArray(input.linkArray)) fail('模型需要 nodeArray 和 linkArray 两个数组。');
    if (input.nodeArray.length > LIMITS.nodes || input.linkArray.length > LIMITS.links) fail('模型过大，请拆分后载入。');
    const nodes = new Map();
    function key(value) {
      if (!((typeof value === 'string' && value.length > 0 && value.length <= 200) || (typeof value === 'number' && Number.isFinite(value)))) fail('节点编号必须是非空字符串或有限数值。');
      if (String(value) in Object.prototype) fail('节点编号不能使用 JavaScript 对象保留名称，请修改编号。');
      return String(value);
    }
    const nodeArray = input.nodeArray.map((node, index) => {
      if (!node || typeof node.type !== 'string' || !has(PORTS, node.type)) fail(`第 ${index + 1} 个节点类型无效。`);
      const id = key(node.key);
      if (nodes.has(id)) fail(`节点编号“${id}”重复。`);
      const result = { key: id, type: node.type };
      for (const field of ['name', 'label', 'memo']) {
        if (node[field] !== undefined) {
          if (typeof node[field] !== 'string' || node[field].length > 2000) fail(`节点 ${id} 的 ${field} 必须是不超过 2000 字的文本。`);
          result[field] = node[field];
        }
      }
      if (node.position !== undefined) {
        if (!node.position || !['x', 'y'].every(axis => Number.isFinite(node.position[axis]) && Math.abs(node.position[axis]) <= 100000)) fail(`节点 ${id} 的位置无效。`);
        result.position = { x: node.position.x, y: node.position.y };
      }
      nodes.set(id, result);
      return result;
    });
    const occupied = new Set();
    const outgoing = new Map(nodeArray.map(node => [node.key, []]));
    const indegree = new Map(nodeArray.map(node => [node.key, 0]));
    const linkArray = input.linkArray.map((link, index) => {
      if (!link || typeof link !== 'object') fail(`第 ${index + 1} 条连线无效。`);
      const from = key(link.from), to = key(link.to);
      if (!nodes.has(from) || !nodes.has(to)) fail(`第 ${index + 1} 条连线引用了不存在的节点。`);
      if (!PORTS[nodes.get(from).type].output.includes(link.frompid) || !PORTS[nodes.get(to).type].input.includes(link.topid)) fail(`第 ${index + 1} 条连线的端口无效。`);
      const target = JSON.stringify([to, link.topid]);
      if (occupied.has(target)) fail(`节点 ${to} 的端口 ${link.topid} 有重复输入。`);
      occupied.add(target);
      outgoing.get(from).push(to);
      indegree.set(to, indegree.get(to) + 1);
      return { from, frompid: link.frompid, to, topid: link.topid };
    });
    const queue = nodeArray.filter(node => indegree.get(node.key) === 0).map(node => node.key);
    for (let index = 0; index < queue.length; index++) {
      for (const next of outgoing.get(queue[index])) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
    }
    if (queue.length !== nodeArray.length) fail('模型存在循环连线，无法作为组合逻辑图载入。');
    return { nodeArray, linkArray };
  }

  function parseModel(text) {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) fail('模型文本不能超过 2 MB。');
    let value;
    try { value = JSON.parse(text.replace(/^\uFEFF/u, '')); }
    catch (_) { fail('JSON 格式无效，请检查引号、逗号和括号。当前图形已保留。'); }
    return validateModel(value);
  }
  return Object.freeze({ compile, tokenize, validateModel, parseModel, PORTS, LIMITS });
});
