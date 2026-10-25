const test = require('node:test');
const assert = require('node:assert/strict');
const specs = require('../question-specs.json');
const { normalizeOutput } = require('../lib/evaluation');

function values(input) { return input.trim().split(/\s+/).map(Number); }
function oracle(id, input) {
  const data = values(input);
  if ([3, 5, 6, 13, 17, 18, 25].includes(Number(id))) {
    const n = data[0], array = data.slice(1, n + 1);
    if (id === '3') return String(array.reduce((sum, value) => sum + value, 0));
    if (id === '5') return String(Math.max(...array));
    if (id === '6') return String(Math.min(...array));
    if (id === '13') return array.reverse().join(' ');
    if (id === '17') return `Positive = ${array.filter(x => x > 0).length}, Negative = ${array.filter(x => x < 0).length}, Zero = ${array.filter(x => x === 0).length}`;
    if (id === '18') return array.map(x => x * 2).join(' ');
    if (id === '25') return String(array.every((value, i) => i === 0 || array[i - 1] <= value));
  }
  if (id === '14' || id === '15') {
    const n = data[0], array = data.slice(1, n + 1), key = data[n + 1], index = array.indexOf(key);
    return id === '14' ? String(index) : String(index >= 0);
  }
  if (id === '22') {
    const n = data[0], target = data[1], array = data.slice(2, n + 2);
    return String(array.some((value, i) => array.some((other, j) => i !== j && value + other === target)));
  }
  throw new Error(`No oracle for question ${id}`);
}
function deliberatelyWrong(id, input) {
  const data = values(input);
  if (id === '3') return String(data[1]);
  if (id === '5') return String(Math.min(...data.slice(1, data[0] + 1)));
  if (id === '6') return String(Math.max(...data.slice(1, data[0] + 1)));
  if (id === '13') return data.slice(1, data[0] + 1).join(' ');
  if (id === '14') return '-1';
  if (id === '15') return 'false';
  if (id === '17') return 'Positive = 0, Negative = 0, Zero = 0';
  if (id === '18') return data.slice(1, data[0] + 1).join(' ');
  if (id === '22') return 'false';
  if (id === '25') return 'true';
  return '';
}

test('each curated question has at least two visible and three question-specific hidden cases', () => {
  assert.deepEqual(Object.keys(specs).sort((a,b)=>Number(a)-Number(b)), ['3','5','6','13','14','15','17','18','22','25']);
  for (const [id, suite] of Object.entries(specs)) {
    assert.ok(suite.sampleTests.length >= 2, `Q${id} sample count`);
    assert.ok(suite.hiddenTests.length >= 3, `Q${id} hidden count`);
    assert.ok(suite.inputFormat && suite.outputFormat && suite.constraints, `Q${id} format`);
  }
});

test('all authored expected outputs match question-specific reference logic and catch a flawed approach', () => {
  for (const [id, suite] of Object.entries(specs)) {
    const all = [...suite.sampleTests, ...suite.hiddenTests];
    for (const [index, item] of all.entries()) {
      assert.equal(normalizeOutput(oracle(id, item.input)), normalizeOutput(item.expectedOutput), `Q${id} case ${index + 1}`);
    }
    assert.ok(all.some(item => normalizeOutput(deliberatelyWrong(id, item.input)) !== normalizeOutput(item.expectedOutput)), `Q${id} must catch its incorrect algorithm`);
  }
});
