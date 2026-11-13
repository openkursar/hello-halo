import { writeFile } from 'node:fs/promises';
const units = text => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const text = values => String.fromCharCode(...values);
const wellFormed = value => value.isWellFormed();
function encode(value) {
  const extensions = [];
  const visit = (value, path) => {
    if (value === undefined) { extensions.push({ kind: 'undefined', path }); return null; }
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
      extensions.push({ kind: 'number', path, value: Object.is(value, -0) ? '-0' : String(value) }); return null;
    }
    if (typeof value === 'string' && !wellFormed(value)) { extensions.push({ kind: 'text16', path, units: units(value) }); return null; }
    if (typeof value === 'function') { extensions.push({ kind: 'callback', path, id: 'callback-fixture' }); return null; }
    if (value instanceof AbortSignal) { extensions.push({ kind: 'signal', path }); return null; }
    if (Array.isArray(value)) return value.map((value, index) => visit(value, [...path, index]));
    if (value && typeof value === 'object') {
      if (Object.keys(value).some(key => !wellFormed(key))) {
        extensions.push({ kind: 'object16', path, entries: Object.entries(value).map(([key, value]) => ({ key: wellFormed(key) ? key : units(key), value: encode(value) })) });
        return null;
      }
      return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, visit(value, [...path, key])]));
    }
    return value;
  };
  const data = visit(value, []);
  return { version: 1, data, extensions };
}
const samples = [[], [65], [0xd83d,0xde00], [0xd800], [0xdc00], [0xd800,97,0xdc00], [0xd83d,0xd83d,0xde00,0xdc01], [0xfeff,32,0xd800,10], [0,8,9,10,12,13,34,92,0x2028,0x2029], [92,117,100,56,48,48], [0x4e2d,0xd83d,0xde00,0x0301]];
let seed=0x31a54f;
for(let i=0;i<64;i++) { const sample=[]; for(let j=0;j<1+i%19;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;sample.push(seed&0xffff);} samples.push(sample); }
const indexValue = value => Number.isFinite(value) ? value : String(value);
const ranges = [[0,1],[1,2],[-1,undefined],[0,-1],[NaN,Infinity],[-Infinity,Infinity],[5,1],[1.9,2.9]];
const texts = samples.map(sample => { const value=text(sample);return {units:sample,length:value.length,wellFormed:wellFormed(value),quote:JSON.stringify(value),trimmed:units(value.trim()),slices:ranges.map(([start,end])=>({start:indexValue(start),...(end===undefined?{}:{end:indexValue(end)}),units:units(value.slice(start,end)),quote:JSON.stringify(value.slice(start,end))}))};});
const literals=JSON.parse('{"__proto__":{"safe":true},"__haloSdkNativeUndefined":true,"extra":1,"nested":{"__haloSdkNativeNumber":"NaN"},"callback":{"__haloSdkNativeCallback":"callback-fixture"},"signal":{"__haloSdkNativeSignal":true},"envelope":{"version":1,"data":null,"extensions":[{"kind":"undefined","path":[]}]}}');
const floatBytes = new ArrayBuffer(8);
const floatView = new DataView(floatBytes);
const numbers = [1794339331661.0015, Number.MIN_VALUE, Number.MAX_VALUE, Number.EPSILON, -0, 1e-7, 1e21];
for (let index = 0; index < 128; index++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  floatView.setUint32(0, seed);
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  floatView.setUint32(4, seed);
  numbers.push(floatView.getFloat64(0));
}
const values = [
  ['literal_markers',literals], ['undefined',undefined], ['negative_zero',-0], ['not_a_number',NaN], ['positive_infinity',Infinity], ['negative_infinity',-Infinity],
  ['mixed',{ literal:literals, absent:undefined, empty:null, values:[undefined,null,-0,NaN,Infinity,-Infinity], signal:new AbortController().signal, fn:()=>1 }],
  ['utf16_values',{ high:text([0xd800]), low:text([0xdc00]), paired:text([0xd83d,0xde00]), literal:'\\ud800' }],
  ['utf16_keys',Object.fromEntries([[text([0xd800]),{nested:undefined}],[text([0xdc00]),text([0xd800])],['plain',{__haloSdkNativeUndefined:true}],['10','ten'],['2','two']])],
  ['numeric_keys',JSON.parse('{"b":1,"10":2,"2":3,"01":4,"4294967295":5,"a":6}')], ['nested_objects',{a:[{[text([0xd800])]:{[text([0xdc00])]:[undefined,text([0xd800])]}}]}],
  ['float64_values', numbers],
];
const fixture={node:process.versions.node,texts,sorted:samples.map(text).sort().map(units),concat:{parts:[[0xd83d],[0xde00]],units:units(text([0xd83d])+text([0xde00])),quote:JSON.stringify(text([0xd83d])+text([0xde00]))},values:values.map(([name,value])=>({name,wire:encode(value),json:JSON.stringify(value)??null,truthy:Boolean(value)}))};
await writeFile(new URL('../native/crates/halo-core/src/js/fixtures/node-values.json',import.meta.url),JSON.stringify(fixture,null,2)+'\n');
console.log(`Generated ${texts.length} text cases and ${values.length} value cases from Node ${process.versions.node}.`);
