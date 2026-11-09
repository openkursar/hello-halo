/**
 * Unit tests for tool-argument checking.
 *
 * Two properties matter and pull against each other: catch the mistakes a
 * model actually makes, and never reject a call the tool would have accepted.
 * The second is the one with teeth — a false rejection locks the model out of
 * that tool for the rest of the session.
 */

import { describe, it, expect } from 'vitest';
import { validateToolInput } from './tool-input.js';

const READ_SCHEMA = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    offset: { type: 'number' },
    limit: { type: 'integer' },
  },
  required: ['file_path'],
};

describe('validateToolInput — accepts', () => {
  it('a call that matches the schema', () => {
    expect(validateToolInput('Read', READ_SCHEMA, { file_path: '/tmp/a', offset: 2 })).toBeNull();
  });

  it('a call that omits optional properties', () => {
    expect(validateToolInput('Read', READ_SCHEMA, { file_path: '/tmp/a' })).toBeNull();
  });

  it('extra properties the schema never mentioned', () => {
    // Models routinely add a field; the schemas do not forbid it, so neither do we.
    expect(validateToolInput('Read', READ_SCHEMA, { file_path: '/a', note: 'why' })).toBeNull();
  });

  it('a tool that publishes no schema', () => {
    expect(validateToolInput('Anything', undefined, { whatever: 1 })).toBeNull();
  });

  it('an integer where a number is asked for', () => {
    expect(validateToolInput('Read', READ_SCHEMA, { file_path: '/a', offset: 2 })).toBeNull();
  });
});

describe('validateToolInput — rejects', () => {
  it('a missing required property', () => {
    const problem = validateToolInput('Read', READ_SCHEMA, { offset: 1 });
    expect(problem).toContain('"file_path" is required');
    expect(problem).toContain('call Read again');
  });

  it('a property of the wrong type, naming what arrived', () => {
    const problem = validateToolInput('Read', READ_SCHEMA, { file_path: '/a', offset: '10' });
    expect(problem).toContain('"offset" must be number');
    expect(problem).toContain('received string');
  });

  it('a fractional value where an integer is asked for', () => {
    const problem = validateToolInput('Read', READ_SCHEMA, { file_path: '/a', limit: 1.5 });
    expect(problem).toContain('"limit" must be integer');
  });

  it('a value outside an enum, listing the choices', () => {
    const schema = {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['plan', 'edit'] } },
    };
    const problem = validateToolInput('Agent', schema, { mode: 'yolo' });
    expect(problem).toContain('"plan", "edit"');
  });

  it('a bad property nested inside an object', () => {
    const schema = {
      type: 'object',
      properties: {
        filter: { type: 'object', properties: { limit: { type: 'number' } } },
      },
    };
    const problem = validateToolInput('Search', schema, { filter: { limit: 'ten' } });
    expect(problem).toContain('"filter.limit"');
  });

  it('a bad element inside an array, naming its position', () => {
    const schema = {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
    };
    const problem = validateToolInput('ReadMany', schema, { paths: ['/a', 7] });
    expect(problem).toContain('"paths[1]"');
  });

  it('reports several problems at once so one correction fixes them all', () => {
    const problem = validateToolInput('Read', READ_SCHEMA, { offset: '1', limit: 'x' });
    expect(problem).toContain('file_path');
    expect(problem).toContain('offset');
    expect(problem).toContain('limit');
  });
});

describe('validateToolInput — stays silent on what it cannot interpret', () => {
  // MCP servers publish schemas we do not control. Guessing at an unfamiliar
  // construct risks blocking a legitimate call, which is the one outcome worse
  // than not checking.
  const compositions = ['oneOf', 'anyOf', 'allOf', 'not'];

  for (const keyword of compositions) {
    it(`a schema using ${keyword}`, () => {
      const schema = {
        type: 'object',
        properties: { value: { [keyword]: [{ type: 'string' }] } },
      };
      expect(validateToolInput('Mcp', schema, { value: 12345 })).toBeNull();
    });
  }

  it('a schema using $ref', () => {
    const schema = {
      type: 'object',
      properties: { value: { $ref: '#/definitions/thing' } },
    };
    expect(validateToolInput('Mcp', schema, { value: 12345 })).toBeNull();
  });

  it('constraints it does not implement, such as pattern and minLength', () => {
    const schema = {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[0-9]+$', minLength: 10 } },
    };
    expect(validateToolInput('Mcp', schema, { id: 'abc' })).toBeNull();
  });

  it('a type name it does not recognise', () => {
    const schema = { type: 'object', properties: { when: { type: 'date-time' } } };
    expect(validateToolInput('Mcp', schema, { when: 12345 })).toBeNull();
  });

  it('a malformed schema', () => {
    expect(validateToolInput('Broken', { type: 'object', properties: 'nonsense' }, { a: 1 })).toBeNull();
    expect(validateToolInput('Broken', { required: 'not-an-array' } as never, {})).toBeNull();
  });

  it('a property allowed to be one of several types', () => {
    const schema = {
      type: 'object',
      properties: { pages: { type: ['string', 'number'] } },
    };
    expect(validateToolInput('Read', schema, { pages: '1-5' })).toBeNull();
    expect(validateToolInput('Read', schema, { pages: 3 })).toBeNull();
    expect(validateToolInput('Read', schema, { pages: true })).toContain('string or number');
  });
});
