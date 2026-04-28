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

  test('constant foo is 5 produces correct tokens', () => {
    const tokens = lex('constant foo is 5');
    expect(tokens[0]).toMatchObject({ type: 'KEYWORD', value: 'constant' });
    expect(tokens[1]).toMatchObject({ type: 'IDENT',   value: 'foo' });
    expect(tokens[2]).toMatchObject({ type: 'KEYWORD', value: 'is' });
    expect(tokens[3]).toMatchObject({ type: 'NUMBER',  value: '5' });
    expect(tokens[4]).toMatchObject({ type: 'NEWLINE' });
  });

  test('emits INDENT and DEDENT for function body', () => {
    const tokens = lex(helloSource);
    expect(tokens.some(t => t.type === 'INDENT')).toBe(true);
    expect(tokens.some(t => t.type === 'DEDENT')).toBe(true);
  });

  test('** is emitted as a single OP token', () => {
    const tokens = lex('function f(number a, number b) is\n    return a ** b\nend function');
    const ops = tokens.filter(t => t.type === 'OP').map(t => t.value);
    expect(ops).toEqual(['**']);
  });

  test('all arithmetic operators tokenised correctly', () => {
    const tokens = lex('function f(number x) is\n    return x + x - x * x / x\nend function');
    const ops = tokens.filter(t => t.type === 'OP').map(t => t.value);
    expect(ops).toEqual(['+', '-', '*', '/']);
  });

  test('parameter named `to` (keyword) is emitted as KEYWORD', () => {
    const tokens = lex('function raise(number a, number to) is\n    return a ** to\nend function');
    const toTokens = tokens.filter(t => t.value === 'to');
    expect(toTokens.length).toBeGreaterThanOrEqual(2);
    expect(toTokens.every(t => t.type === 'KEYWORD')).toBe(true);
  });

  test('number literals tokenised', () => {
    const tokens = lex('constant x is 42');
    expect(tokens.some(t => t.type === 'NUMBER' && t.value === '42')).toBe(true);
  });

  test('numbers may use _ as digit separator', () => {
    const tokens = lex('constant x is 10_000');
    const nums = tokens.filter(t => t.type === 'NUMBER');
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBe('10000');
  });

  test('multi-group _ separator (1_000_000)', () => {
    const tokens = lex('constant x is 1_000_000');
    const nums = tokens.filter(t => t.type === 'NUMBER');
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBe('1000000');
  });

  test('trailing _ is not consumed by number lexer', () => {
    // 10_ -> NUMBER(10) IDENT(_)
    const tokens = lex('say 10_');
    const nums = tokens.filter(t => t.type === 'NUMBER');
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBe('10');
    expect(tokens.some(t => t.type === 'IDENT' && t.value === '_')).toBe(true);
  });

  test('double underscore is not consumed (1__0)', () => {
    // 1__0 -> NUMBER(1) IDENT(__0)
    const tokens = lex('say 1__0');
    const nums = tokens.filter(t => t.type === 'NUMBER');
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBe('1');
    expect(tokens.some(t => t.type === 'IDENT' && t.value === '__0')).toBe(true);
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
    const tokens2 = lex('repeat with i from 1 to 5\n    say i\nend repeat');
    const kws2 = tokens2.filter(t => t.type === 'KEYWORD').map(t => t.value);
    expect(kws2).toContain('with');
    expect(kws2).toContain('from');
    expect(kws2).toContain('to');
    const tokens3 = lex('repeat while false\n    say 1\nend repeat');
    expect(tokens3.filter(t => t.type === 'KEYWORD').map(t => t.value)).toContain('while');
  });

  test('comparison words tokenize as KEYWORDs', () => {
    const tokens = lex('if a is less than b and c is at least d and e is greater than f and g is at most h\n    say 1\nend if');
    const kws = new Set(tokens.filter(t => t.type === 'KEYWORD').map(t => t.value));
    for (const w of ['less', 'greater', 'than', 'at', 'least', 'most']) {
      expect(kws.has(w)).toBe(true);
    }
  });

  test('var/change/add/subtract/multiply/divide/by tokenize as KEYWORDs', () => {
    const src = 'variable x is 1\nchange x to 2\nadd 1 to x\nsubtract 1 from x\nmultiply x by 2\ndivide x by 2';
    const tokens = lex(src);
    const kws = new Set(tokens.filter(t => t.type === 'KEYWORD').map(t => t.value));
    for (const w of ['variable', 'change', 'add', 'subtract', 'multiply', 'divide', 'by']) {
      expect(kws.has(w)).toBe(true);
    }
  });

  test('list-related keywords tokenize as KEYWORDs', () => {
    const src = 'constant l is list of 1, 2\nempty list of number\nlast item of l\nlength of l\nl contains 1\nappend 1 to l\nprepend 1 to l\ninsert 1 at 1 in l\nremove item 1 from l\nrepeat with x in l\n    say x\nend repeat\nreadonly list of number';
    const tokens = lex(src);
    const kws = new Set(tokens.filter(t => t.type === 'KEYWORD').map(t => t.value));
    for (const w of ['list', 'of', 'empty', 'item', 'last', 'length', 'contains', 'append', 'prepend', 'insert', 'in', 'remove', 'readonly']) {
      expect(kws.has(w)).toBe(true);
    }
  });

  test('reserves character and characters keywords', () => {
    const tokens = lex('character 1 of "hi"\ncharacters 1 to 2 of "hi"');
    const kws = tokens.filter(t => t.type === 'KEYWORD').map(t => t.value);
    expect(kws).toContain('character');
    expect(kws).toContain('characters');
  });

  test('& is emitted as an OP token', () => {
    const tokens = lex('say "a" & "b"');
    const ops = tokens.filter(t => t.type === 'OP').map(t => t.value);
    expect(ops).toEqual(['&']);
  });
});
