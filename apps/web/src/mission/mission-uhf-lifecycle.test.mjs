import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual component with deterministic hooks and deferred API replies.
const slots = [];
let cursor = 0;
let effects = [];
const requests = [];
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [
      slots[index],
      (value) => {
        slots[index] = value;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useEffect(setup, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: setup() };
      });
    }
  },
};
const jsx = (type, props) => ({ type, props });
const source = await readFile(new URL('./MissionUhfControls.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  AbortController,
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === '../controls/RadioControls') return { Field: 'field', Select: 'select' };
    if (name === '../api')
      return {
        api: (url, options) => new Promise((resolve) => requests.push({ url, resolve, options })),
      };
    throw new Error(`Unexpected dependency ${name}`);
  },
});
let config = { name: 'First mission' };
let edits = 0;
function render() {
  cursor = 0;
  effects = [];
  const tree = exports.MissionUhfControls({
    config,
    edit(change) {
      edits++;
      change(config);
    },
  });
  for (const effect of effects) effect();
  return tree;
}
function checkbox(element) {
  if (!element || typeof element !== 'object') return;
  if (element?.type === 'input' && element.props.type === 'checkbox') return element;
  const children = element?.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = checkbox(child);
    if (found) return found;
  }
}
checkbox(render()).props.onChange({ target: { checked: true } });
assert.equal(checkbox(render()).props.disabled, true);
config = { ...config, name: 'Replaced mission' };
render();
assert.equal(requests[0].options.signal.aborted, true);
assert.equal(
  checkbox(render()).props.disabled,
  false,
  'Changing missions must release UHF loading',
);
requests[0].resolve({ obsolete: true });
await new Promise(setImmediate);
assert.equal(edits, 0, 'A stale UHF profile must not replace the new mission');
checkbox(render()).props.onChange({ target: { checked: true } });
assert.equal(requests.length, 2, 'The receiver model must be loadable again');
requests[1].resolve({ fresh: true });
await new Promise(setImmediate);
assert.equal(edits, 1);
assert.equal(config.uhf_beacon.fresh, true);
assert.equal(requests[1].url, '/api/mission/uhf-beacon/default');
console.log('UHF loading rejects a stale profile after mission replacement.');
