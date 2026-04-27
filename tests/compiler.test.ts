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
    const bc = compileSource('function double takes number a returns number is\n    return a * 2\nend function');
    expect(bc.functions.has('double')).toBe(true);
    const fn = bc.functions.get('double')!;
    expect(fn.params).toEqual(['a']);
    expect(fn.instructions).toContainEqual({ op: 'LOAD', name: 'a' });
    expect(fn.instructions).toContainEqual({ op: 'PUSH_INT', value: 2 });
    expect(fn.instructions).toContainEqual({ op: 'MUL' });
    expect(fn.instructions).toContainEqual({ op: 'RETURN' });
  });

  test('compiles call with positional arg', () => {
    const src = 'function double takes number a returns number is\n    return a * 2\nend function\ndouble 5';
    const bc = compileSource(src);
    const pushIdx = bc.main.findIndex(i => i.op === 'PUSH_INT' && (i as any).value === 5);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(bc.main[pushIdx + 1]).toMatchObject({ op: 'CALL', name: 'double', argCount: 1 });
  });

  test('emits STORE_IT after a call statement', () => {
    const src = 'function double takes number a returns number is\n    return a * 2\nend function\ndouble 5';
    const bc = compileSource(src);
    const callIdx = bc.main.findIndex(i => i.op === 'CALL');
    expect(bc.main[callIdx + 1]).toMatchObject({ op: 'STORE_IT' });
  });

  test('reorders named args to match parameter declaration order', () => {
    const src = [
      'function raise takes number a to number to returns number is',
      '    return a ** to',
      'end function',
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

  test('duplicate-labeled params consume call args in declaration order', () => {
    const src = [
      'function sum3 takes number a with number b with number c returns number is',
      '    return a + b + c',
      'end function',
      'sum3 1 with 2 with 3',
    ].join('\n');
    const bc = compileSource(src);
    const callIdx = bc.main.findIndex(i => i.op === 'CALL' && (i as any).name === 'sum3');
    // args pushed in param order: a=1, b=2, c=3
    expect(bc.main[callIdx - 3]).toMatchObject({ op: 'PUSH_INT', value: 1 });
    expect(bc.main[callIdx - 2]).toMatchObject({ op: 'PUSH_INT', value: 2 });
    expect(bc.main[callIdx - 1]).toMatchObject({ op: 'PUSH_INT', value: 3 });
    expect(bc.main[callIdx]).toMatchObject({ op: 'CALL', name: 'sum3', argCount: 3 });
  });

  test('too many args with the same label is a CompileError', () => {
    const src = [
      'function pair takes number a with number b returns number is',
      '    return a + b',
      'end function',
      'pair 1 with 2 with 3',
    ].join('\n');
    expect(() => compileSource(src)).toThrow(/label 'with'/);
  });

  test('unknown label is a CompileError', () => {
    const src = [
      'function raise takes number a to number to returns number is',
      '    return a ** to',
      'end function',
      'raise 2 by 3',
    ].join('\n');
    // `by` is a reserved stop keyword, so this actually fails at parse time.
    expect(() => compileSource(src)).toThrow();
  });

  test('missing required arg is a CompileError', () => {
    const src = [
      'function raise takes number a to number to returns number is',
      '    return a ** to',
      'end function',
      'raise 2',
    ].join('\n');
    expect(() => compileSource(src)).toThrow(/Missing argument/);
  });

  test('compiles exponentiation to POW', () => {
    const src = 'function pow takes number a b number b returns number is\n    return a ** b\nend function';
    const bc = compileSource(src);
    expect(bc.functions.get('pow')!.instructions).toContainEqual({ op: 'POW' });
  });

  test('function body uses LOAD_IT for `it`', () => {
    const src = [
      'function quadruple takes number a returns number is',
      '    double a',
      '    double it',
      '    return it',
      'end function',
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
    const src = 'set foo to 5\nfunction f takes number foo is\n    return foo\nend function';
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
        'function f takes number i returns number is',
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
      const bc = compileSource('if 1 is less than 2\n    say 1\nend if');
      expect(bc.main.some(i => i.op === 'LT')).toBe(true);
    });
    test('is at most emits LE', () => {
      const bc = compileSource('if 1 is at most 2\n    say 1\nend if');
      expect(bc.main.some(i => i.op === 'LE')).toBe(true);
    });
    test('is greater than emits GT', () => {
      const bc = compileSource('if 1 is greater than 2\n    say 1\nend if');
      expect(bc.main.some(i => i.op === 'GT')).toBe(true);
    });
    test('is at least emits GE', () => {
      const bc = compileSource('if 1 is at least 2\n    say 1\nend if');
      expect(bc.main.some(i => i.op === 'GE')).toBe(true);
    });
  });

  describe('var / change / compound assign', () => {
    test('var x is 5 emits STORE_VAR', () => {
      const bc = compileSource('var x is 5');
      expect(bc.main).toContainEqual({ op: 'PUSH_INT', value: 5 });
      expect(bc.main).toContainEqual({ op: 'STORE_VAR', name: 'x' });
    });

    test('change x to 6 emits STORE_VAR', () => {
      const bc = compileSource('var x is 5\nchange x to 6');
      const storeVars = bc.main.filter(i => i.op === 'STORE_VAR' && (i as any).name === 'x');
      expect(storeVars).toHaveLength(2);
    });

    test('add N to x emits LOAD, PUSH, ADD, STORE_VAR', () => {
      const bc = compileSource('var x is 5\nadd 3 to x');
      const tail = bc.main.slice(-4);
      expect(tail).toEqual([
        { op: 'LOAD', name: 'x' },
        { op: 'PUSH_INT', value: 3 },
        { op: 'ADD' },
        { op: 'STORE_VAR', name: 'x' },
      ]);
    });

    test('multiply x by 2 emits LOAD, PUSH, MUL, STORE_VAR', () => {
      const bc = compileSource('var x is 5\nmultiply x by 2');
      const tail = bc.main.slice(-4);
      expect(tail).toEqual([
        { op: 'LOAD', name: 'x' },
        { op: 'PUSH_INT', value: 2 },
        { op: 'MUL' },
        { op: 'STORE_VAR', name: 'x' },
      ]);
    });

    test('change targeting a set binding is a compile error', () => {
      expect(() => compileSource('set x to 5\nchange x to 6')).toThrow(CompileError);
    });

    test('change targeting an undeclared name is a compile error', () => {
      expect(() => compileSource('change x to 5')).toThrow(CompileError);
    });

    test('var redeclaring a set is a compile error', () => {
      expect(() => compileSource('set x to 5\nvar x is 6')).toThrow(CompileError);
    });

    test('var redeclaring a var is a compile error', () => {
      expect(() => compileSource('var x is 5\nvar x is 6')).toThrow(CompileError);
    });

    test('set after var is a compile error', () => {
      expect(() => compileSource('var x is 5\nset x to 6')).toThrow(CompileError);
    });

    test('add on a string-locked var is a compile error', () => {
      expect(() => compileSource('var s is "hi"\nadd 1 to s')).toThrow(/not number/);
    });

    test('add on a boolean-locked var is a compile error', () => {
      expect(() => compileSource('var b is true\nadd 1 to b')).toThrow(/not number/);
    });

    test('var inside a function does not leak to siblings; sibling function can reuse the name', () => {
      const src = [
        'function f returns number is',
        '    var x is 1',
        '    return x',
        'end function',
        'function g returns number is',
        '    var x is 2',
        '    return x',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).not.toThrow();
    });

    test('var shadowing an outer (top-level) set is a compile error inside a function', () => {
      const src = [
        'set x to 1',
        'function f returns number is',
        '    var x is 2',
        '    return x',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(/shadow/);
    });

    test('change on a loop variable is a compile error', () => {
      const src = [
        'repeat with i from 1 to 3',
        '    change i to 99',
        'end repeat',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(CompileError);
    });

    test('change on a function parameter is a compile error', () => {
      const src = [
        'function f takes number a returns number is',
        '    change a to 99',
        '    return a',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(CompileError);
    });

    test('var declared in outer function is not visible to inner change (function-local)', () => {
      // f has var x; g is a sibling that tries to change x — should fail.
      const src = [
        'function f returns number is',
        '    var x is 1',
        '    return x',
        'end function',
        'function g returns number is',
        '    change x to 5',
        '    return x',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(CompileError);
    });
  });

  describe('return types', () => {
    test('void function: implicit PUSH_INT 0 + RETURN at end', () => {
      const bc = compileSource('function greet is\n    say "hi"\nend function');
      const fn = bc.functions.get('greet')!;
      const tail = fn.instructions.slice(-2);
      expect(tail).toEqual([{ op: 'PUSH_INT', value: 0 }, { op: 'RETURN' }]);
    });

    test('void function: call site emits DROP (not STORE_IT)', () => {
      const src = 'function greet is\n    say "hi"\nend function\ngreet';
      const bc = compileSource(src);
      const callIdx = bc.main.findIndex(i => i.op === 'CALL');
      expect(bc.main[callIdx + 1]).toMatchObject({ op: 'DROP' });
      expect(bc.main.some(i => i.op === 'STORE_IT')).toBe(false);
    });

    test('typed function: no implicit trailing PUSH_INT 0 when body terminates', () => {
      const bc = compileSource('function f returns number is\n    return 42\nend function');
      const fn = bc.functions.get('f')!;
      // Last instruction should be RETURN, not an implicit extra return
      expect(fn.instructions[fn.instructions.length - 1]).toEqual({ op: 'RETURN' });
      // Should have exactly one RETURN
      expect(fn.instructions.filter(i => i.op === 'RETURN').length).toBe(1);
    });

    test('typed function: call site emits STORE_IT', () => {
      const src = 'function double takes number n returns number is\n    return n * 2\nend function\ndouble 3';
      const bc = compileSource(src);
      const callIdx = bc.main.findIndex(i => i.op === 'CALL');
      expect(bc.main[callIdx + 1]).toMatchObject({ op: 'STORE_IT' });
    });

    test('void function + return EXPR → compile error', () => {
      expect(() => compileSource('function f is\n    return 5\nend function')).toThrow(
        /void function 'f' cannot return a value/,
      );
    });

    test('typed function + bare return → compile error', () => {
      expect(() => compileSource('function f returns number is\n    return\nend function')).toThrow(
        /must return a number/,
      );
    });

    test('typed function with fall-through → missing return', () => {
      expect(() => compileSource('function f returns number is\n    say "hi"\nend function')).toThrow(
        /missing return/,
      );
    });

    test('typed function with if missing else → missing return', () => {
      const src = [
        'function f takes number n returns number is',
        '    if n is 0',
        '        return 1',
        '    end if',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(/missing return/);
    });

    test('typed function with if/else both returning → compiles', () => {
      const src = [
        'function f takes number n returns number is',
        '    if n is 0',
        '        return 1',
        '    else',
        '        return 2',
        '    end if',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).not.toThrow();
    });

    test('typed function: static-type mismatch (returns number but literal string) → compile error', () => {
      expect(() =>
        compileSource('function f returns number is\n    return "hi"\nend function'),
      ).toThrow(/Type mismatch/);
    });

    test('typed function: return uses CHECK_TYPE when static type unknown', () => {
      // `it` has unknown static type, so a runtime check must be emitted.
      const src = [
        'function g returns string is',
        '    return "hi"',
        'end function',
        'function f returns number is',
        '    g',
        '    return it',
        'end function',
      ].join('\n');
      const bc = compileSource(src);
      const fn = bc.functions.get('f')!;
      expect(fn.instructions.some(i => i.op === 'CHECK_TYPE')).toBe(true);
    });

    test('void function used as value in set → compile error', () => {
      const src = 'function greet is\n    say "hi"\nend function\nset x to greet';
      expect(() => compileSource(src)).toThrow(
        /void function 'greet' cannot be used as a value/,
      );
    });

    test('void function used in arithmetic → compile error', () => {
      const src = 'function greet is\n    say "hi"\nend function\nsay greet + 1';
      expect(() => compileSource(src)).toThrow(/void function 'greet'/);
    });
  });

  describe('lists', () => {
    test('emits MAKE_LIST for nonempty literal', () => {
      const bc = compileSource('set l to list of 1, 2, 3');
      expect(bc.main).toContainEqual({ op: 'MAKE_LIST', count: 3, elementType: 'number' });
    });

    test('emits MAKE_EMPTY_LIST with element type', () => {
      const bc = compileSource('set l to empty list of boolean');
      expect(bc.main).toContainEqual({ op: 'MAKE_EMPTY_LIST', elementType: 'boolean' });
    });

    test('mixed static types in literal → compile error', () => {
      expect(() => compileSource('set l to list of 1, "hi"')).toThrow(/mixed element types/);
    });

    test('append to non-list var → compile error', () => {
      expect(() => compileSource('set x to 5\nappend 1 to x')).toThrow(/not a list/);
    });

    test('append inside function with readonly param → compile error', () => {
      const src = 'function f takes readonly list of number xs is\n    append 1 to xs\nend function';
      expect(() => compileSource(src)).toThrow(/readonly list reference/);
    });

    test('change item with readonly param → compile error', () => {
      const src = 'function f takes readonly list of number xs is\n    change item 1 of xs to 9\nend function';
      expect(() => compileSource(src)).toThrow(/readonly/);
    });

    test('set x to readonly param → compile error (no smuggling)', () => {
      const src = 'function f takes readonly list of number xs is\n    set other to xs\n    say length of other\nend function';
      expect(() => compileSource(src)).toThrow(/readonly-list reference/);
    });

    test('var other is readonly param → compile error', () => {
      const src = 'function f takes readonly list of number xs is\n    var other is xs\nend function';
      expect(() => compileSource(src)).toThrow(/readonly-list reference/);
    });

    test('widening: mutable arg → readonly param OK', () => {
      const src = 'function f takes readonly list of number xs returns number is\n    return length of xs\nend function\nset l to list of 1, 2\nf l\nsay it';
      expect(() => compileSource(src)).not.toThrow();
    });

    test('narrowing: readonly arg → mutable param rejected', () => {
      const src = [
        'function inner takes list of number xs is',
        '    append 1 to xs',
        'end function',
        'function outer takes readonly list of number xs is',
        '    inner xs',
        'end function',
      ].join('\n');
      expect(() => compileSource(src)).toThrow(/Cannot pass readonly-list reference/);
    });

    test('pass scalar to list param → compile error', () => {
      const src = 'function f takes list of number xs is\n    say length of xs\nend function\nf 5';
      expect(() => compileSource(src)).toThrow(/Type mismatch/);
    });

    test('return readonly list reference from function → compile error', () => {
      const src = 'function f takes readonly list of number xs returns list of number is\n    return xs\nend function';
      expect(() => compileSource(src)).toThrow(/readonly/);
    });

    test('change var list to different element type → compile error', () => {
      const src = 'var l is list of 1, 2\nchange l to list of "a", "b"';
      expect(() => compileSource(src)).toThrow(/Type mismatch/);
    });

    test('append wrong-type literal → compile error', () => {
      const src = 'set l to list of 1, 2\nappend "hi" to l';
      expect(() => compileSource(src)).toThrow(/cannot append string to list of number/);
    });

    test('change x in list iteration → compile error', () => {
      const src = 'repeat with x in list of 1, 2, 3\n    change x to 5\nend repeat';
      expect(() => compileSource(src)).toThrow(/Cannot change 'x'/);
    });

    test('contains compiles to CONTAINS', () => {
      const bc = compileSource('set l to list of 1, 2\nsay l contains 1');
      expect(bc.main).toContainEqual({ op: 'CONTAINS' });
    });
  });

  describe('string operations (static checks)', () => {
    test('& compiles to CONCAT', () => {
      const bc = compileSource('say "a" & "b"');
      expect(bc.main).toContainEqual({ op: 'CONCAT' });
    });

    test('character N of S compiles to STR_CHAR_AT', () => {
      const bc = compileSource('say character 1 of "hi"');
      expect(bc.main).toContainEqual({ op: 'STR_CHAR_AT' });
    });

    test('characters A to B of S compiles to STR_SUBSTRING', () => {
      const bc = compileSource('say characters 1 to 2 of "hi"');
      expect(bc.main).toContainEqual({ op: 'STR_SUBSTRING' });
    });

    test('length of uses polymorphic LENGTH op', () => {
      const bc = compileSource('say length of "hi"');
      expect(bc.main).toContainEqual({ op: 'LENGTH' });
    });

    test('string contains non-string RHS → compile error', () => {
      expect(() => compileSource('say "hi" contains 5')).toThrow(/contains/);
    });

    test('character N of non-string → compile error', () => {
      expect(() => compileSource('set n to 5\nsay character 1 of n')).toThrow(/character/);
    });

    test('first character of non-string → compile error', () => {
      expect(() => compileSource('set n to 5\nsay first character of n')).toThrow(/character/);
    });

    test('last character of non-string → compile error', () => {
      expect(() => compileSource('set n to 5\nsay last character of n')).toThrow(/character/);
    });

    test('characters A to B of non-string → compile error', () => {
      expect(() => compileSource('set n to 5\nsay characters 1 to 2 of n')).toThrow(/string/);
    });

    test('length of on boolean → compile error', () => {
      expect(() => compileSource('set b to true\nsay length of b')).toThrow(/list or string/);
    });

    test('& always returns string (staticType via use in function return)', () => {
      // If string return type enforcement works, compiling this should succeed.
      const src = 'function f returns string is\n    return "x=" & 1 + 2\nend function';
      expect(() => compileSource(src)).not.toThrow();
    });
  });

  describe('the result of sugar', () => {
    test('emits call then STORE_IT then LOAD_IT then STORE for set', () => {
      const src = 'function f takes number n returns number is\n    return n\nend function\nset x to the result of f 5';
      const bc = compileSource(src);
      const main = bc.main;
      const callIdx = main.findIndex(i => i.op === 'CALL' && (i as any).name === 'f');
      expect(callIdx).toBeGreaterThanOrEqual(0);
      expect(main[callIdx + 1]).toMatchObject({ op: 'STORE_IT' });
      expect(main[callIdx + 2]).toMatchObject({ op: 'LOAD_IT' });
      expect(main[callIdx + 3]).toMatchObject({ op: 'STORE', name: 'x' });
    });

    test('void function in the result of → compile error', () => {
      const src = 'function noop is\n    say "hi"\nend function\nset x to the result of noop';
      expect(() => compileSource(src)).toThrow(/void/);
    });

    test('unknown function in the result of → compile error', () => {
      expect(() => compileSource('set x to the result of nope 5')).toThrow(/unknown function/);
    });
  });

  describe('static type checks', () => {
    test('arithmetic with string operand is a compile error', () => {
      expect(() => compileSource('say 5 + "hi"')).toThrow(/arithmetic requires numbers.*string/);
    });

    test('arithmetic with boolean operand is a compile error', () => {
      expect(() => compileSource('say 5 + true')).toThrow(/arithmetic requires numbers.*boolean/);
    });

    test('mod with string operand is a compile error', () => {
      expect(() => compileSource('say "x" mod 3')).toThrow(/arithmetic requires numbers/);
    });

    test('unary minus on string is a compile error', () => {
      expect(() => compileSource('say -"hi"')).toThrow(/unary '-' requires number/);
    });

    test('not on number is a compile error', () => {
      expect(() => compileSource('say not 5')).toThrow(/'not' requires a boolean/);
    });

    test('and with non-boolean is a compile error', () => {
      expect(() => compileSource('say 5 and true')).toThrow(/'and' requires booleans/);
    });

    test('or with non-boolean is a compile error', () => {
      expect(() => compileSource('say "hi" or false')).toThrow(/'or' requires booleans/);
    });

    test('equality across known-different types is a compile error', () => {
      expect(() => compileSource('say 5 is "hi"')).toThrow(/cannot compare/);
    });

    test('inequality across known-different types is a compile error', () => {
      expect(() => compileSource('say 5 is not "hi"')).toThrow(/cannot compare/);
    });

    test('comparison with non-number is a compile error', () => {
      expect(() => compileSource('say 5 is less than "x"')).toThrow(/comparison requires numbers/);
    });

    test('if with non-boolean condition is a compile error', () => {
      expect(() => compileSource('if 5\n  say "x"\nend if')).toThrow(/'if' condition must be a boolean/);
    });

    test('repeat while with non-boolean is a compile error', () => {
      expect(() => compileSource('repeat while "hi"\n  say "x"\nend repeat')).toThrow(/'repeat while' requires a boolean/);
    });

    test('repeat N times with non-number is a compile error', () => {
      expect(() => compileSource('repeat "hi" times\n  say "x"\nend repeat')).toThrow(/'repeat N times' requires a number/);
    });

    test('repeat with literal-negative count is a compile error', () => {
      expect(() => compileSource('repeat -3 times\n  say "x"\nend repeat')).toThrow(/repeat count cannot be negative/);
    });

    test('expect with non-boolean predicate is a compile error', () => {
      expect(() => compileSource('expect 42')).toThrow(/expect requires a boolean, got number/);
    });

    test('passes through unknown types via `it` (no false positive)', () => {
      // it has unknown static type; arithmetic should compile fine.
      expect(() => compileSource('say it + 1')).not.toThrow();
    });

    test('passes through string concat (& never type-checked)', () => {
      expect(() => compileSource('say 5 & "x"')).not.toThrow();
      expect(() => compileSource('say true & 1')).not.toThrow();
    });
  });
});
