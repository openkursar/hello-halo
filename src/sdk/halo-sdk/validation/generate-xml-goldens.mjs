import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const referencePath = process.argv[2], wirePath = process.argv[3];
if (!referencePath || !wirePath) throw new Error('Pass the compiled reference SDK entry and typed wire module.');
const { parseXmlToolCalls } = await import(pathToFileURL(resolve(referencePath)).href);
const { encodeWire } = await import(pathToFileURL(resolve(wirePath)).href);
const output = process.argv[4] ?? fileURLToPath(new URL('../native/crates/halo-core/src/llm/tool_calling/fixtures/xml-parameters.json', import.meta.url));
const cases = [];
function observe(result) {
  return {
    textContent: result.textContent,
    toolCalls: result.toolCalls.map(call => {
      const prototype = Object.getPrototypeOf(call.parameters);
      return {
        name: call.name,
        rawXml: call.rawXml,
        parameters: {
          ownEntries: Object.entries(call.parameters),
          prototype: prototype === Object.prototype ? { kind: 'default' }
            : prototype === null ? { kind: 'null' } : { kind: 'data', value: prototype },
        },
      };
    }),
  };
}
function add(name, text, names = ['T']) {
  cases.push({ name, input: encodeWire([text, names]), expected: encodeWire(observe(parseXmlToolCalls(text, names))) });
}
const existing = JSON.parse(await readFile(new URL('../native/crates/halo-core/src/llm/tool_calling/fixtures/reference.json', import.meta.url), 'utf8'));
for (const [index, fixture] of existing.parsers.entries()) if (fixture.format === 'xml') add(`existing-${index}`, fixture.text, fixture.names);

const tools = ['Bash', 'Read', 'Write', 'Edit', 'TodoWrite', 'Agent'];
const original = [
  ['Just some text.', tools], ['', tools], ['<Bash><command>ls</command></Bash>', []],
  ['<Bash>\n<command>ls -la</command>\n</Bash>', tools],
  ['<Read>\n<file_path>/tmp/foo.ts</file_path>\n</Read>', tools],
  ['I will read this file:\n\n<Read>\n<file_path>/tmp/foo.ts</file_path>\n</Read>', tools],
  ['<Bash>\n<command>ls</command>\n</Bash>', tools],
  ['<Read>\n<file_path>/tmp/foo.ts</file_path>\n<offset>100</offset>\n<limit>50</limit>\n</Read>', tools],
  ['<Bash>\n<command>npm test</command>\n<run_in_background>true</run_in_background>\n</Bash>', ['Bash']],
  ['<Read>\n<file_path>/tmp/x</file_path>\n<limit>500</limit>\n</Read>', tools],
  ['<TodoWrite>\n<todos>[{"content":"Fix","status":"in_progress","activeForm":"Fixing"}]</todos>\n</TodoWrite>', [...tools, 'TodoWrite']],
  ['<Agent>\n<prompt>Explore codebase</prompt>\n</Agent>', tools],
  ['<Bash>\n<command></command>\n</Bash>', tools],
  ['<Write>\n<file_path>/tmp/x.ts</file_path>\n<content>line 1\nline 2\nline 3</content>\n</Write>', tools],
  ['<Bash>\n<command>ls</command>\n</Bash>\n\n<Read>\n<file_path>/tmp/x</file_path>\n</Read>', tools],
  ['<Read>\n<file_path>/a</file_path>\n</Read>\n<Bash>\n<command>ls</command>\n</Bash>', tools],
  ['<UnknownTool>\n<param>val</param>\n</UnknownTool>', tools],
  ['<Bash>\n<command>ls</command>\n<unknown_param>val</unknown_param>\n</Bash>', tools],
  ['<bash>\n<command>ls</command>\n</bash>', ['Bash']],
  ['<Bash>\n<command>ls</command>\n</Bash>', tools],
  ['<mcp__web-search__web_search>\n<query>hello world</query>\n</mcp__web-search__web_search>', ['mcp__web-search__web_search']],
  ['<Bash>\n<command>x</command>\n<timeout>1.5</timeout>\n</Bash>', tools],
  ['<Read>\n<file_path>/x</file_path>\n<offset>-1</offset>\n</Read>', tools],
  ['<Edit>\n<file_path>/src/foo.ts</file_path>\n<old_string>return foo() + 1;</old_string>\n<new_string>return foo() + 2;</new_string>\n</Edit>', tools],
];
original.forEach(([text, names], index) => add(`source-test-${index}`, text, names));

const param = (name, value) => `<param name="${name}">${value}</param>`;
for (const [index, value] of ['', 'raw\0value', '\ud800', '\udfff', '😀\ud800中\udfff', '"\ud800"', '"\udfff"', '"\\ud800"', '"\\udfff"',
  '"\0"', '"\\u0000"', '{"\ud800":"\udfff"}', '{"\\ud800":"\\udfff"}', '{"__proto__":{"literal":true}}',
  '{"__haloSdkNativeUndefined":true,"keep":"literal"}', '{"__haloSdkNativeNumber":"NaN"}',
  '{"__haloSdkNativeUndefined":true}', '{"__haloSdkNativeNumber":"Infinity"}',
  '{"__haloSdkNativeCallback":"callback-fixture"}', '{"__haloSdkNativeSignal":true}',
  '{"version":1,"data":null,"extensions":[{"path":[],"kind":"undefined"}]}',
  '-0', '-0.0', '-1e-9999', '1e9999', '-1e9999', '+Infinity', 'Infinity', '-Infinity', 'NaN', '+.5', '01', '0x20000000000003', '0b101', '0o17', '-0x1', '+0x1', '1_000',
  'true', 'false', 'null', '{}', '[]', '[null,-0,1e9999,{"__proto__":2}]', '"\\\ud800"', '"line\nbreak"', '"line\\nbreak"'].entries()) {
  add(`coercion-${index}`, `<T>${param('value', value)}</T>`);
}
for (const [index, name] of ['plain', '\ud800', '\udfff', 'x\0y', '😀', '10', '2', '__proto__', 'constructor', 'toString'].entries()) {
  add(`parameter-name-${index}`, `<T>${param(name, '"content\ud800"')}</T>`);
}
for (const [index, name] of ['', '\ud800', '\udfff', 'x\0y', '😀', 'a.b', 'a|b', 'x[0]', 'a>b'].entries()) {
  add(`tool-name-${index}`, `before\ud800\ufeff \n<${name}>${param('value', '7')}</${name}> ignored <${name}></${name}>`, [name]);
}
const prototypes = [
  [param('__proto__', 'null') + param('__proto__', '{"next":2}'), 'null-then-object'],
  [param('__proto__', 'null') + param('__proto__', 'true'), 'null-then-primitive'],
  [param('__proto__', '{"__proto__":{"shadow":1}}') + param('__proto__', '{"replacement":2}'), 'shadowed-setter'],
  [param('__proto__', '{"inherited":3}') + param('own', '4'), 'data-prototype'],
  [param('__proto__', '{"inherited":3}') + param('__proto__', 'null'), 'data-then-null'],
  [param('__proto__', 'null') + '<toString/><constructor/><__proto__/>', 'null-inherited-names'],
  [param('__proto__', '[9]') + '<0/><1/><length/><map/><toString/><missing/>', 'array-inherited-names'],
  [param('__proto__', '{"inherited":3}') + '<inherited/><toString/><missing/>', 'object-inherited-names'],
  [param('__proto__', '4') + '<toString/><missing/>', 'primitive-prototype-ignored'],
  ['<__proto__>null</__proto__><__proto__>{"next":2}</__proto__>', 'legacy-null-then-object'],
  [param('__proto__', '{"nested":"<legacy>5</legacy>"}'), 'prototype-only-legacy-fallback'],
  [param('value', '{"__proto__":null}') + '<ignored/>', 'json-own-prototype-key'],
];
for (const [body, name] of prototypes) add(name, `<T>${body}</T>`);
for (const [index, body] of [
  param('value', '1') + '<legacy>2</legacy><empty/>',
  '<param name="">ignored</param><legacy>2</legacy><empty/>',
  param('value', '1') + param('value', '2') + param('2', '3') + param('1', '4'),
  '<legacy>1</legacy><legacy>2</legacy><legacy/><missing/>',
  '<param xname="value">7</param>',
  '<param\ufeffname="value">7</param>',
  '<param\u0085name="value">7</param><fallback>8</fallback>',
  '<param name="value">"<nested>1</nested>"</param>',
  '<param name="value">"</param>"</param><fallback>2</fallback>',
  '<constructor/><toString/><valueOf/><__proto__/><missing/>',
].entries()) add(`selection-${index}`, `<T>${body}</T>`);
for (const [index, value] of [undefined, null, false, 0, -0, NaN, ''].entries()) add(`falsy-${index}`, value);
add('empty-names-retain-data', { __haloSdkNativeUndefined: true, keep: 'literal' }, []);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ node: process.versions.node, cases }) + '\n');
console.log(JSON.stringify({ cases: cases.length, original: original.length, output }));
