import * as fs from 'fs';
import * as path from 'path';
import { lex } from '../src/lexer';
import { parse } from '../src/parser';
import { compile, CompileError } from '../src/compiler';

function compileSource(source: string) {
  return compile(parse(lex(source)));
}

describe('Compiler', () => {
  test('compiles say statement (does not store to it)', () => {
    const bc = compileSource('say "Hello World"');
    expect(bc.main).toContainEqual({ op: 'PUSH_STR', value: 'Hello World' });
    expect(bc.main).toContainEqual({ op: 'SAY' });
    // `say` must NOT update `it`
    expect(bc.main).not.toContainEqual({ op: 'STORE_IT' });
  });

  test('compiles set statement', () => {
    const bc = compileSource('set foo to 5');
    expect(bc.main).toContainEqual({ op: 'PUSH_INT', value: 5 });
    expect(bc.main).toContainEqual({ op: 'STORE', name: 'foo' });
  });

  test('compiles set with it expression', () => {
    const bc = compileSource('set baz to it');
    expect(bc.main).toContainEqual({ op: 'LOAD_IT' });
    expect(bc.main).toContainEqual({ op: 'STORE', name: 'baz' });
  });

  test('compiles function declaration with correct params and instructions', () => {
    const bc = compileSource('function double(number a) is\n    return a * 2\nend');
    expect(bc.functions.has('double')).toBe(true);
    const fn = bc.functions.get('double')!;
    expect(fn.params).toEqual(['a']);
    expect(fn.instructions).toContainEqual({ op: 'LOAD', name: 'a' });
    expect(fn.instructions).toContainEqual({ op: 'PUSH_INT', value: 2 });
    expect(fn.instructions).toContainEqual({ op: 'MUL' });
    expect(fn.instructions).toContainEqual({ op: 'RETURN' });
  });

  test('compiles call with positional arg', () => {
    const src = 'function double(number a) is\n    return a * 2\nend\ndouble 5';
    const bc = compileSource(src);
    const pushIdx = bc.main.findIndex(i => i.op === 'PUSH_INT' && (i as any).value === 5);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(bc.main[pushIdx + 1]).toMatchObject({ op: 'CALL', name: 'double', argCount: 1 });
  });

  test('emits STORE_IT after a call statement', () => {
    const src = 'function double(number a) is\n    return a * 2\nend\ndouble 5';
    const bc = compileSource(src);
    const callIdx = bc.main.findIndex(i => i.op === 'CALL');
    expect(bc.main[callIdx + 1]).toMatchObject({ op: 'STORE_IT' });
  });

  test('reorders named args to match parameter declaration order', () => {
    const src = [
      'function raise(number a, number to) is',
      '    return a ** to',
      'end',
      'raise 5 to 3',
    ].join('\n');
    const bc = compileSource(src);
    const callIdx = bc.main.findIndex(i => i.op === 'CALL' && (i as any).name === 'raise');
    expect(callIdx).toBeGreaterThanOrEqual(0);
    // Args must be in param order: a=5, to=3
    expect(bc.main[callIdx - 2]).toMatchObject({ op: 'PUSH_INT', value: 5 });
    expect(bc.main[callIdx - 1]).toMatchObject({ op: 'PUSH_INT', value: 3 });
    expect(bc.main[callIdx]).toMatchObject({ op: 'CALL', name: 'raise', argCount: 2 });
  });

  test('compiles exponentiation to POW', () => {
    const src = 'function pow(number a, number b) is\n    return a ** b\nend';
    const bc = compileSource(src);
    expect(bc.functions.get('pow')!.instructions).toContainEqual({ op: 'POW' });
  });

  test('function body uses LOAD_IT for `it`', () => {
    const src = [
      'function quadruple(number a) is',
      '    double a',
      '    double it',
      '    return it',
      'end',
    ].join('\n');
    // quadruple calls an unknown function 'double', but compiler still emits LOAD_IT
    const bc = compileSource(src);
    const fn = bc.functions.get('quadruple')!;
    expect(fn.instructions.filter(i => i.op === 'LOAD_IT').length).toBeGreaterThanOrEqual(2);
  });

  test('throws CompileError on duplicate set', () => {
    expect(() => compileSource('set foo to 5\nset foo to 6')).toThrow(CompileError);
  });

  test('throws CompileError when param shadows outer binding', () => {
    const src = 'set foo to 5\nfunction f(number foo) is\n    return foo\nend';
    expect(() => compileSource(src)).toThrow(CompileError);
  });

  test('compiles hello_world.chatter end-to-end', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../examples/hello_world.chatter'),
      'utf-8',
    );
    const bc = compileSource(source);

    expect(bc.main.length).toBeGreaterThan(0);
    expect(bc.functions.has('double')).toBe(true);
    expect(bc.functions.has('quadruple')).toBe(true);
    expect(bc.functions.has('raise')).toBe(true);

    // say "Hello World" → PUSH_STR + SAY at the start of main
    expect(bc.main[0]).toMatchObject({ op: 'PUSH_STR', value: 'Hello World' });
    expect(bc.main[1]).toMatchObject({ op: 'SAY' });

    // set foo to 5
    expect(bc.main).toContainEqual({ op: 'PUSH_INT', value: 5 });
    expect(bc.main).toContainEqual({ op: 'STORE', name: 'foo' });

    // set bar to 6
    expect(bc.main).toContainEqual({ op: 'PUSH_INT', value: 6 });
    expect(bc.main).toContainEqual({ op: 'STORE', name: 'bar' });

    // double foo → LOAD "foo", CALL "double" 1, STORE_IT
    const callDoubleIdx = bc.main.findIndex(i => i.op === 'CALL' && (i as any).name === 'double');
    expect(callDoubleIdx).toBeGreaterThanOrEqual(0);
    expect(bc.main[callDoubleIdx - 1]).toMatchObject({ op: 'LOAD', name: 'foo' });
    expect(bc.main[callDoubleIdx + 1]).toMatchObject({ op: 'STORE_IT' });

    // raise foo to bar → LOAD "foo", LOAD "bar", CALL "raise" 2
    const callRaiseIdx = bc.main.findIndex(i => i.op === 'CALL' && (i as any).name === 'raise');
    expect(callRaiseIdx).toBeGreaterThanOrEqual(0);
    expect(bc.main[callRaiseIdx]).toMatchObject({ op: 'CALL', name: 'raise', argCount: 2 });
    expect(bc.main[callRaiseIdx - 2]).toMatchObject({ op: 'LOAD', name: 'foo' });
    expect(bc.main[callRaiseIdx - 1]).toMatchObject({ op: 'LOAD', name: 'bar' });

    // `double` function body: LOAD "a", PUSH_INT 2, MUL, RETURN
    const fn = bc.functions.get('double')!;
    expect(fn.params).toEqual(['a']);
    expect(fn.instructions).toEqual([
      { op: 'LOAD', name: 'a' },
      { op: 'PUSH_INT', value: 2 },
      { op: 'MUL' },
      { op: 'RETURN' },
    ]);
  });

  describe('repeat statements', () => {
    test('repeat N times emits LT comparison and a back-edge JUMP', () => {
      const bc = compileSource('repeat 2 times\n    say "x"\nend repeat');
      const ops = bc.main.map(i => i.op);
      expect(ops).toContain('LT');
      expect(ops).toContain('JUMP');
      expect(ops).toContain('JUMP_IF_FALSE');
      expect(ops).toContain('ERROR');
      // back-edge JUMP target must point earlier (it's a loop)
      const jumpIdx = bc.main.findIndex(i => i.op === 'JUMP');
      const target = (bc.main[jumpIdx] as any).target;
      expect(target).toBeLessThan(jumpIdx);
    });

    test('repeat range emits LE comparison and DELETEs the loop var', () => {
      const bc = compileSource('repeat with i from 1 to 3\n    say i\nend repeat');
      const ops = bc.main.map(i => i.op);
      expect(ops).toContain('LE');
      expect(bc.main).toContainEqual({ op: 'DELETE', name: 'i' });
    });

    test('repeat while emits no LT/LE/ERROR, just cond + JUMP_IF_FALSE + back-edge', () => {
      const bc = compileSource('repeat while false\n    say "x"\nend repeat');
      const ops = bc.main.map(i => i.op);
      expect(ops).toContain('JUMP_IF_FALSE');
      expect(ops).toContain('JUMP');
      expect(ops).not.toContain('LT');
      expect(ops).not.toContain('LE');
      expect(ops).not.toContain('ERROR');
    });

    test('loop variable shadowing outer set raises CompileError', () => {
      const src = 'set i to 5\nrepeat with i from 1 to 3\n    say i\nend repeat';
      expect(() => compileSource(src)).toThrow(CompileError);
      expect(() => compileSource(src)).toThrow(/shadow/);
    });

    test('loop variable shadowing an outer loop variable raises CompileError', () => {
      const src = [
        'repeat with i from 1 to 3',
        '    repeat with i from 1 to 2',
        '        say i',
        '    end repeat',
        'end repeat',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(CompileError);
    });

    test('loop variable shadowing a param raises CompileError', () => {
      const src = [
        'function f(number i) is',
        '    repeat with i from 1 to 3',
        '        say i',
        '    end repeat',
        '    return i',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(CompileError);
    });

    test('`set i to X` inside loop body raises CompileError (duplicate binding)', () => {
      const src = [
        'repeat with i from 1 to 3',
        '    set i to 99',
        'end repeat',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(CompileError);
    });

    test('reusing loop var name in a sibling (non-overlapping) loop is fine', () => {
      const src = [
        'repeat with i from 1 to 3',
        '    say i',
        'end repeat',
        'repeat with i from 1 to 2',
        '    say i',
        'end repeat',
      ].join('\n');
      expect(() => compileSource(src)).not.toThrow();
    });
  });

  describe('comparison operators', () => {
    test('is less than emits LT', () => {
      const bc = compileSource('if 1 is less than 2\n    say 1\nend');
      expect(bc.main.some(i => i.op === 'LT')).toBe(true);
    });
    test('is at most emits LE', () => {
      const bc = compileSource('if 1 is at most 2\n    say 1\nend');
      expect(bc.main.some(i => i.op === 'LE')).toBe(true);
    });
    test('is greater than emits GT', () => {
      const bc = compileSource('if 1 is greater than 2\n    say 1\nend');
      expect(bc.main.some(i => i.op === 'GT')).toBe(true);
    });
    test('is at least emits GE', () => {
      const bc = compileSource('if 1 is at least 2\n    say 1\nend');
      expect(bc.main.some(i => i.op === 'GE')).toBe(true);
    });
  });
});
