import { lex } from '../src/lexer';
import { parse, ParseError } from '../src/parser';
import { compile, CompileError } from '../src/compiler';
import { VM, RuntimeError } from '../src/vm';
import { formatError, ChatterError } from '../src/errors';

function runSource(source: string): Error {
  try {
    const ast = parse(lex(source), source);
    const program = compile(ast);
    new VM(program).run();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected an error but none was thrown');
}

describe('formatError', () => {
  test('ParseError points at offending token', () => {
    const source = 'say\nconstant 5 is 1\n';
    const err = runSource(source);
    expect(err).toBeInstanceOf(ParseError);
    const out = formatError(err, source, 'x.chatter');
    // ParseError from `say` line 1: "say requires at least one expression"
    // The first failure is actually at line 1 because NEWLINE follows `say`.
    expect(out).toMatch(/^error: /);
    expect(out).toContain(' --> x.chatter:1:');
    expect(out).toContain(' |');
    // Caret line present
    expect(out).toMatch(/\|\s+\^+/);
  });

  test('ParseError with explicit token location', () => {
    const source = 'constant 5 is 1\n';
    const err = runSource(source);
    expect(err).toBeInstanceOf(ParseError);
    const out = formatError(err, source, 'p.chatter');
    // `set` consumes, then expects IDENT but gets NUMBER '5' at col 4
    expect(out).toContain('--> p.chatter:1:10');
    expect(out).toContain('1 | constant 5 is 1');
    // caret at column 10
    expect(out).toMatch(/\n\s+\|\s{10}\^/);
  });

  test('CompileError for statement-level error points at statement start', () => {
    const source = 'constant x is 1\nconstant x is 2\n';
    const err = runSource(source);
    expect(err).toBeInstanceOf(CompileError);
    const out = formatError(err, source, 'dup.chatter');
    expect(out).toContain("error: Duplicate binding: 'x' is already declared");
    expect(out).toContain('--> dup.chatter:2:1');
    expect(out).toContain('2 | constant x is 2');
    // caret starts at col 1 (no leading spaces before ^)
    expect(out).toMatch(/\n\s+\|\s*\^/);
  });

  test('CompileError for identifier-level error — location from expression', () => {
    // change undeclared var
    const source = 'change y to 5\n';
    const err = runSource(source);
    expect(err).toBeInstanceOf(CompileError);
    const out = formatError(err, source, 'u.chatter');
    expect(out).toContain("error: Cannot change 'y'");
    expect(out).toContain('--> u.chatter:1:');
    expect(out).toContain('1 | change y to 5');
  });

  test('RuntimeError carries location from executing instruction', () => {
    const source = 'say 1 / 0\n';
    const err = runSource(source);
    expect(err).toBeInstanceOf(RuntimeError);
    const out = formatError(err, source, 'r.chatter');
    expect(out).toContain('error: Division by zero');
    expect(out).toContain('--> r.chatter:1:');
    expect(out).toContain('1 | say 1 / 0');
    expect(out).toMatch(/\|\s+\^+/);
  });

  test('Missing location falls back to bare header', () => {
    const err = new ChatterError('something went wrong');
    expect(formatError(err, '', '')).toBe('error: something went wrong');
  });

  test('Multi-digit line number gutter aligns', () => {
    // Construct 12 lines, error on line 12.
    const lines = [];
    for (let i = 0; i < 11; i++) lines.push('constant x' + i + ' is 1');
    lines.push('constant x0 is 2'); // duplicate of x0 on line 12
    const source = lines.join('\n') + '\n';
    const err = runSource(source);
    const out = formatError(err, source, 'm.chatter');
    // Gutter should be 2-wide. `12 | ` and `   | ` headers should align.
    const outLines = out.split('\n');
    // header, --> line, blank gutter, source line, caret line
    expect(outLines.length).toBe(5);
    expect(outLines[1]).toMatch(/^  --> m\.chatter:12:1/);
    expect(outLines[2]).toBe('   |');
    expect(outLines[3].startsWith('12 | ')).toBe(true);
    expect(outLines[4].startsWith('   | ')).toBe(true);
  });
});

describe('formatError golden shape', () => {
  test('full formatted ParseError output matches spec', () => {
    const source = 'constant x is 5\nconstant x is 6\n';
    const err = runSource(source);
    const out = formatError(err, source, 'examples/dup.chatter');
    // Compile error (duplicate set) shows spec-shaped output.
    expect(out).toBe(
      [
        "error: Duplicate binding: 'x' is already declared",
        ' --> examples/dup.chatter:2:1',
        '  |',
        '2 | constant x is 6',
        '  | ^^^^^^^^',
      ].join('\n'),
    );
  });
});
