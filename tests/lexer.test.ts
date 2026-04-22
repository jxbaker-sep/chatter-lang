import * as fs from 'fs';
import * as path from 'path';
import { lex } from '../src/lexer';

describe('Lexer', () => {
  const helloSource = fs.readFileSync(
    path.join(__dirname, '../examples/hello_world.chatter'),
    'utf-8',
  );

  test('no COMMENT tokens emitted (comments are skipped)', () => {
    const tokens = lex(helloSource);
    expect(tokens.every(t => t.type !== 'COMMENT')).toBe(true);
  });

  test('first meaningful token is KEYWORD say', () => {
    const tokens = lex(helloSource);
    expect(tokens[0]).toMatchObject({ type: 'KEYWORD', value: 'say' });
  });

  test('string literal Hello World', () => {
    const tokens = lex(helloSource);
    expect(tokens[1]).toMatchObject({ type: 'STRING', value: 'Hello World' });
  });

  test('set foo to 5 produces correct tokens', () => {
    const tokens = lex('set foo to 5');
    expect(tokens[0]).toMatchObject({ type: 'KEYWORD', value: 'set' });
    expect(tokens[1]).toMatchObject({ type: 'IDENT',   value: 'foo' });
    expect(tokens[2]).toMatchObject({ type: 'KEYWORD', value: 'to' });
    expect(tokens[3]).toMatchObject({ type: 'NUMBER',  value: '5' });
    expect(tokens[4]).toMatchObject({ type: 'NEWLINE' });
  });

  test('emits INDENT and DEDENT for function body', () => {
    const tokens = lex(helloSource);
    expect(tokens.some(t => t.type === 'INDENT')).toBe(true);
    expect(tokens.some(t => t.type === 'DEDENT')).toBe(true);
  });

  test('** is emitted as a single OP token', () => {
    const tokens = lex('function f(number a, number b) is\n    return a ** b\nend');
    const ops = tokens.filter(t => t.type === 'OP').map(t => t.value);
    expect(ops).toEqual(['**']);
  });

  test('all arithmetic operators tokenised correctly', () => {
    const tokens = lex('function f(number x) is\n    return x + x - x * x / x\nend');
    const ops = tokens.filter(t => t.type === 'OP').map(t => t.value);
    expect(ops).toEqual(['+', '-', '*', '/']);
  });

  test('parameter named `to` (keyword) is emitted as KEYWORD', () => {
    const tokens = lex('function raise(number a, number to) is\n    return a ** to\nend');
    const toTokens = tokens.filter(t => t.value === 'to');
    expect(toTokens.length).toBeGreaterThanOrEqual(2);
    expect(toTokens.every(t => t.type === 'KEYWORD')).toBe(true);
  });

  test('number literals tokenised', () => {
    const tokens = lex('set x to 42');
    expect(tokens.some(t => t.type === 'NUMBER' && t.value === '42')).toBe(true);
  });

  test('last token is always EOF', () => {
    expect(lex('')[0].type).toBe('EOF');
    expect(lex(helloSource).at(-1)!.type).toBe('EOF');
  });

  test('tokenises entire hello_world.chatter without error', () => {
    expect(() => lex(helloSource)).not.toThrow();
    const tokens = lex(helloSource);
    expect(tokens.length).toBeGreaterThan(0);
  });

  test('repeat/times/with/from/while tokenise as KEYWORD', () => {
    const tokens = lex('repeat 3 times\n    say "hi"\nend repeat');
    const kws = tokens.filter(t => t.type === 'KEYWORD').map(t => t.value);
    expect(kws).toContain('repeat');
    expect(kws).toContain('times');
    expect(kws).toContain('end');
    const tokens2 = lex('repeat with i from 1 to 5\n    say i\nend');
    const kws2 = tokens2.filter(t => t.type === 'KEYWORD').map(t => t.value);
    expect(kws2).toContain('with');
    expect(kws2).toContain('from');
    expect(kws2).toContain('to');
    const tokens3 = lex('repeat while false\n    say 1\nend');
    expect(tokens3.filter(t => t.type === 'KEYWORD').map(t => t.value)).toContain('while');
  });
});
