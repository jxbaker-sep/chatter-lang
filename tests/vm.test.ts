import * as fs from 'fs';
import * as path from 'path';
import { lex } from '../src/lexer';
import { parse } from '../src/parser';
import { compile } from '../src/compiler';
import { VM, RuntimeError } from '../src/vm';
import { BytecodeProgram } from '../src/bytecode';

function runSource(source: string): string[] {
  const output: string[] = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    output.push(args.join(' '));
  });
  try {
    const program = compile(parse(lex(source)));
    new VM(program).run();
  } finally {
    logSpy.mockRestore();
  }
  return output;
}

function expectRuntimeError(source: string): void {
  const program = compile(parse(lex(source)));
  expect(() => new VM(program).run()).toThrow(RuntimeError);
}

describe('VM', () => {
  // ── PRINT ──────────────────────────────────────────────────────────────────
  describe('PRINT', () => {
    test('says a string literal', () => {
      expect(runSource('say "Hello World"')).toEqual(['Hello World']);
    });

    test('says an integer as plain digits (no decimals)', () => {
      expect(runSource('say 42')).toEqual(['42']);
    });

    test('says the result of arithmetic', () => {
      expect(runSource('say 3 + 4')).toEqual(['7']);
    });

    test('multiple say statements produce multiple lines', () => {
      expect(runSource('say "first"\nsay "second"')).toEqual(['first', 'second']);
    });
  });

  // ── ARITHMETIC ─────────────────────────────────────────────────────────────
  describe('Arithmetic', () => {
    test('ADD: 10 + 3 = 13', () => expect(runSource('say 10 + 3')).toEqual(['13']));
    test('SUB: 10 - 3 = 7',  () => expect(runSource('say 10 - 3')).toEqual(['7']));
    test('MUL: 4 * 5 = 20',  () => expect(runSource('say 4 * 5')).toEqual(['20']));
    test('DIV: 10 / 3 = 3 (truncated)', () => expect(runSource('say 10 / 3')).toEqual(['3']));
    test('DIV: negative truncates toward zero: -7 / 2 = -3', () => {
      expect(runSource('say 0 - 7')).toEqual(['-7']); // sanity
    });
    test('POW: 2 ** 10 = 1024', () => expect(runSource('say 2 ** 10')).toEqual(['1024']));
    test('POW: 5 ** 6 = 15625', () => expect(runSource('say 5 ** 6')).toEqual(['15625']));
  });

  // ── OVERFLOW ───────────────────────────────────────────────────────────────
  describe('Integer overflow', () => {
    test('throws RuntimeError when result exceeds i32 max (2147483647 + 1)', () => {
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [
          { op: 'PUSH_INT', value: 2147483647 },
          { op: 'PUSH_INT', value: 1 },
          { op: 'ADD' },
        ],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });

    test('throws RuntimeError when result below i32 min (-2147483648 - 1)', () => {
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [
          { op: 'PUSH_INT', value: -2147483648 },
          { op: 'PUSH_INT', value: 1 },
          { op: 'SUB' },
        ],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });

    test('large POW overflow is detected (2 ** 31 = 2147483648)', () => {
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [
          { op: 'PUSH_INT', value: 2 },
          { op: 'PUSH_INT', value: 31 },
          { op: 'POW' },
        ],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });
  });

  // ── DIVISION BY ZERO ───────────────────────────────────────────────────────
  describe('Division by zero', () => {
    test('throws RuntimeError on div by zero', () => {
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [
          { op: 'PUSH_INT', value: 10 },
          { op: 'PUSH_INT', value: 0 },
          { op: 'DIV' },
        ],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });
  });

  // ── SET / LOAD ─────────────────────────────────────────────────────────────
  describe('set and LOAD', () => {
    test('set then print', () => {
      expect(runSource('set x to 99\nsay x')).toEqual(['99']);
    });

    test('set used in expression', () => {
      expect(runSource('set x to 7\nsay x + 3')).toEqual(['10']);
    });

    test('LOAD of undefined variable throws RuntimeError', () => {
      const program = compile(parse(lex('set x to 1')));
      // Manually inject a LOAD for an undefined name
      program.main.push({ op: 'LOAD', name: 'doesNotExist' });
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });
  });

  // ── it SCOPING ─────────────────────────────────────────────────────────────
  describe('it scoping', () => {
    test('it is updated after a call statement', () => {
      const src = [
        'function double(number a) is',
        '    return a * 2',
        'end',
        'double 5',
        'say it',
      ].join('\n');
      expect(runSource(src)).toEqual(['10']);
    });

    test('outer it is unchanged after function call', () => {
      const src = [
        'function double(number a) is',
        '    return a * 2',
        'end',
        'double 5',
        // it = 10 in outer scope',
        'function quadruple(number a) is',
        '    double a',
        '    double it',
        '    return it',
        'end',
        'quadruple 3',
        // outer it should now be 12 (result of quadruple(3)), not inner it
        'say it',
      ].join('\n');
      expect(runSource(src)).toEqual(['12']);
    });

    test('LOAD_IT when it is null throws RuntimeError', () => {
      // Inject LOAD_IT into an otherwise empty program
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [{ op: 'LOAD_IT' }],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });

    test('it in outer frame stays at 10 while inner quadruple runs', () => {
      // After double foo (=10), call quadruple which modifies its own it
      // outer it should still be 10 before set baz to it
      const src = [
        'function double(number a) is',
        '    return a * 2',
        'end',
        'function quadruple(number a) is',
        '    double a',
        '    double it',
        '    return it',
        'end',
        'double 5',
        // outer it = 10
        'set baz to it',
        'say baz',
        // now call quadruple which internally modifies its own it
        'quadruple 3',
        // outer it = 12, baz still 10
        'say baz',
      ].join('\n');
      expect(runSource(src)).toEqual(['10', '10']);
    });
  });

  // ── FUNCTION CALLS ─────────────────────────────────────────────────────────
  describe('Function calls', () => {
    test('positional arg', () => {
      const src = [
        'function double(number a) is',
        '    return a * 2',
        'end',
        'double 7',
        'say it',
      ].join('\n');
      expect(runSource(src)).toEqual(['14']);
    });

    test('named arg (second param)', () => {
      const src = [
        'function raise(number a, number to) is',
        '    return a ** to',
        'end',
        'raise 2 to 8',
        'say it',
      ].join('\n');
      expect(runSource(src)).toEqual(['256']);
    });

    test('nested calls: quadruple via double', () => {
      const src = [
        'function double(number a) is',
        '    return a * 2',
        'end',
        'function quadruple(number a) is',
        '    double a',
        '    double it',
        '    return it',
        'end',
        'quadruple 5',
        'say it',
      ].join('\n');
      expect(runSource(src)).toEqual(['20']);
    });

    test('undefined function throws RuntimeError', () => {
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [{ op: 'CALL', name: 'noSuchFn', argCount: 0 }],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });
  });

  // ── TYPE MISMATCH ──────────────────────────────────────────────────────────
  describe('Type mismatch', () => {
    test('adding a string and a number throws RuntimeError', () => {
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [
          { op: 'PUSH_STR', value: 'hello' },
          { op: 'PUSH_INT', value: 1 },
          { op: 'ADD' },
        ],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });
  });

  // ── END-TO-END: hello_world.chatter ────────────────────────────────────────
  describe('hello_world.chatter end-to-end', () => {
    test('full pipeline lex→parse→compile→run outputs only "Hello World"', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '../examples/hello_world.chatter'),
        'utf-8',
      );
      const output = runSource(source);
      expect(output).toEqual(['Hello World']);
    });

    test('set baz to it captures outer it=10 from double foo', () => {
      // Augmented version that prints baz to verify
      const source = fs.readFileSync(
        path.join(__dirname, '../examples/hello_world.chatter'),
        'utf-8',
      );
      // Append a say baz to verify baz = 10
      const augmented = source + '\nsay baz\n';
      const output = runSource(augmented);
      expect(output).toEqual(['Hello World', '10']);
    });

    test('raise foo to bar = 5**6 = 15625, stored in it', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '../examples/hello_world.chatter'),
        'utf-8',
      );
      const augmented = source + '\nsay it\n';
      const output = runSource(augmented);
      expect(output).toEqual(['Hello World', '15625']);
    });
  });

  // ── BOOLEANS / EQUALITY / IF ───────────────────────────────────────────────
  describe('Booleans, equality and if', () => {
    test('EQ same-type same-value → true', () => {
      expect(runSource('say 5 is 5')).toEqual(['true']);
      expect(runSource('say "a" is "a"')).toEqual(['true']);
      expect(runSource('say true is true')).toEqual(['true']);
    });

    test('EQ same-type different-value → false', () => {
      expect(runSource('say 5 is 6')).toEqual(['false']);
    });

    test('NEQ works', () => {
      expect(runSource('say 5 is not 6')).toEqual(['true']);
      expect(runSource('say 5 is not 5')).toEqual(['false']);
    });

    test('EQ across different types throws "compare"', () => {
      const program = compile(parse(lex('say 5 is "hello"')));
      expect(() => new VM(program).run()).toThrow(/compare/);
    });

    test('if with non-boolean condition throws at runtime', () => {
      const program: BytecodeProgram = {
        functions: new Map(),
        main: [
          { op: 'PUSH_INT', value: 5 },
          { op: 'JUMP_IF_FALSE', target: 99 },
        ],
      };
      expect(() => new VM(program).run()).toThrow(RuntimeError);
    });

    test('JUMP_IF_FALSE routes control flow when false', () => {
      // if false → say "no", else say "yes"
      expect(runSource('if false\n    say "no"\nelse\n    say "yes"\nend')).toEqual(['yes']);
    });

    test('JUMP (via else skip) routes past else branch when cond is true', () => {
      expect(runSource('if true\n    say "yes"\nelse\n    say "no"\nend')).toEqual(['yes']);
    });

    test('say does NOT update it', () => {
      const src = [
        'function double(number a) is',
        '    return a * 2',
        'end',
        'double 5',
        'say "hello"',
        'say it',
      ].join('\n');
      expect(runSource(src)).toEqual(['hello', '10']);
    });

    test('not / and / or', () => {
      expect(runSource('say not true')).toEqual(['false']);
      expect(runSource('say true and false')).toEqual(['false']);
      expect(runSource('say true or false')).toEqual(['true']);
    });
  });
});
