'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, parseModel, validateModel } = require('../src/core.js');

// Independent postfix oracle and generated-graph interpreter verify semantics end to end.
function oracle(expression, values) {
  const stack = [];
  for (const token of expression.split(/\s+/)) {
    if (token === '<') stack.push(!stack.pop());
    else if (['.', ',', '>', '='].includes(token)) {
      const b = stack.pop(), a = stack.pop();
      stack.push(token === '.' ? a && b : token === ',' ? a || b : token === '>' ? !a || b : a === b);
    } else stack.push(token === '1' ? true : token === '0' ? false : values[token]);
  }
  return stack.pop();
}
function evaluate(model, values) {
  const nodes = new Map(model.nodeArray.map(n => [n.key, n]));
  const inputs = new Map(model.linkArray.map(l => [JSON.stringify([l.to, l.topid]), l.from]));
  const memo = new Map();
  function visit(key) {
    if (memo.has(key)) return memo.get(key);
    const n = nodes.get(key);
    const input = port => visit(inputs.get(JSON.stringify([key, port])));
    const value = n.type === '0' ? false : n.type === '1' ? true : n.type === 'Import' ? values[n.name] : n.type === 'Export' ? input('OUT') : input(input('SI') ? '1' : '0');
    memo.set(key, value);
    return value;
  }
  return visit('output');
}
function verify(expression) {
  const model = compile(expression).model;
  for (let mask = 0; mask < 8; mask++) {
    const values = { a: Boolean(mask & 1), b: Boolean(mask & 2), c: Boolean(mask & 4) };
    assert.equal(evaluate(model, values), oracle(expression, values), `${expression} @ ${mask}`);
  }
}
test('all operators, constants, single variables and compound expressions', () => {
  ['0', '1', 'a', 'a <', 'a b .', 'a b ,', 'a b >', 'a b =', 'a b . c >', 'a b . a c , =', 'a a < .', 'a a < ,', 'a b > b a > .'].forEach(verify);
});
test('deterministic generated expressions match independent truth oracle', () => {
  let seed = 1729;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  function expression(depth) {
    if (depth === 0 || random(5) === 0) return ['a', 'b', 'c', '0', '1'][random(5)];
    const operator = ['.', ',', '>', '=', '<'][random(5)];
    return operator === '<' ? `${expression(depth - 1)} <` : `${expression(depth - 1)} ${expression(depth - 1)} ${operator}`;
  }
  for (let i = 0; i < 300; i++) verify(expression(4));
});
test('malformed expressions produce actionable errors', () => {
  for (const input of ['', '  \n ', 'a b', 'a b c .', 'a .', '<', 'a b.', 'a b . .']) assert.throws(() => compile(input));
  assert.doesNotThrow(() => compile('a\t b\n .'));
});
test('reserved object names and numeric names cannot collide with generated node IDs', () => {
  const model = compile('__proto__ constructor . 2 ,').model;
  assert.equal(new Set(model.nodeArray.map(n => n.key)).size, model.nodeArray.length);
  assert.equal(evaluate(model, { ['__proto__']: true, constructor: true, '2': false }), true);
});
test('tautologies, contradictions and repeated branches are reduced', () => {
  assert.equal(compile('a a < ,').stats.decisions, 0);
  assert.equal(compile('a a < .').stats.decisions, 0);
  assert.equal(compile('a a .').stats.decisions, 1);
  assert.equal(compile('a b . a b . ,').stats.decisions, compile('a b .').stats.decisions);
});
test('legacy models, positions and metadata survive serialization', () => {
  const legacy = { nodeArray: [{ key: 1, type: '1', name: '真', memo: '备注', label: '标签', position: { x: 10, y: 30 } }, { key: 2, type: 'Export', name: 'Out' }], linkArray: [{ from: 1, frompid: 'OUT', to: 2, topid: 'OUT' }] };
  const normalized = validateModel(legacy);
  assert.equal(normalized.nodeArray[0].key, '1');
  assert.deepEqual(parseModel('\uFEFF' + JSON.stringify(normalized)), normalized);
  assert.deepEqual(legacy.nodeArray[0].key, 1);
});
test('bad JSON, unknown types, duplicate IDs, dangling links and invalid positions are rejected', () => {
  assert.throws(() => parseModel('{nodeArray: []}'));
  assert.throws(() => validateModel({}));
  const model = compile('a').model;
  const mutate = callback => { const copy = structuredClone(model); callback(copy); assert.throws(() => validateModel(copy)); };
  mutate(m => m.nodeArray.push(m.nodeArray[0]));
  mutate(m => m.nodeArray[0].type = '__proto__');
  mutate(m => m.nodeArray[0].type = ['SEL']);
  mutate(m => m.nodeArray[0].key = '__proto__');
  mutate(m => m.nodeArray[0].position = { x: NaN, y: 0 });
  mutate(m => m.linkArray[0].from = 'missing');
  mutate(m => m.linkArray[0].frompid = 'wrong-port');
  mutate(m => m.linkArray.push(m.linkArray[0]));
});
test('cycle detection and size limits protect rendering', () => {
  assert.throws(() => validateModel({ nodeArray: [{ key: 's', type: 'SEL' }], linkArray: [{ from: 's', frompid: 'N', to: 's', topid: 'SI' }] }), /循环/);
  assert.throws(() => compile('a ' + '< '.repeat(512)), /词元/);
  assert.throws(() => compile(Array.from({ length: 65 }, (_, i) => `a${i}`).join(' ') + ' .'.repeat(64)), /不同变量/);
  assert.throws(() => parseModel(' '.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});
test('large conjunction stays compact instead of enumerating its truth table', () => {
  const expression = Array.from({ length: 30 }, (_, i) => `v${i}`).join(' ') + ' .'.repeat(29);
  assert.equal(compile(expression).stats.decisions, 30);
});
