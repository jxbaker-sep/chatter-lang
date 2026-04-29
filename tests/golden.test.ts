import * as fs from 'fs';
import * as path from 'path';
import { lex } from '../src/lexer';
import { parse } from '../src/parser';
import { compile, CompileError } from '../src/compiler';
import { VM, RuntimeError } from '../src/vm';

const CHATTER_DIR = path.join(__dirname, 'chatter');

interface Expectation {
  stdout: string;
  error: string | null;  // expected error message substring, or null if no error
}

/**
 * Expected output conventions:
 * - tests/chatter/<name>.chatter: the source program
 * - tests/chatter/<name>.expected: expected stdout (exact match, trailing newline trimmed)
 * - If the first line of .expected is "ERROR: <substring>", the program is expected
 *   to raise a CompileError or RuntimeError whose message contains <substring>.
 */
function loadExpectation(expectedPath: string): Expectation {
  const raw = fs.readFileSync(expectedPath, 'utf8');
  const trimmed = raw.replace(/\n$/, '');
  const firstLine = trimmed.split('\n')[0];
  const errorMatch = /^ERROR:\s*(.*)$/.exec(firstLine);
  if (errorMatch) {
    return { stdout: '', error: errorMatch[1].trim() };
  }
  return { stdout: trimmed, error: null };
}

function runChatter(source: string): { stdout: string; error: Error | null } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const tokens = lex(source);
    const ast = parse(tokens, source);
    const program = compile(ast);
    const vm = new VM(program);
    vm.run();
    return { stdout: logs.join('\n'), error: null };
  } catch (e) {
    return { stdout: logs.join('\n'), error: e as Error };
  } finally {
    console.log = originalLog;
  }
}

function discoverCases(): Array<{ name: string; sourcePath: string; expectedPath: string }> {
  if (!fs.existsSync(CHATTER_DIR)) return [];
  const cases: Array<{ name: string; sourcePath: string; expectedPath: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir)) {
      const entryPath = path.join(dir, entry);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.endsWith('.chatter')) continue;
      const expectedPath = entryPath.replace(/\.chatter$/, '.expected');
      if (!fs.existsSync(expectedPath)) continue;
      const rel = path.relative(CHATTER_DIR, entryPath).replace(/\.chatter$/, '');
      cases.push({
        name: rel.split(path.sep).join('/'),
        sourcePath: entryPath,
        expectedPath,
      });
    }
  };
  walk(CHATTER_DIR);
  return cases;
}

describe('chatter golden file tests', () => {
  const cases = discoverCases();

  if (cases.length === 0) {
    test.skip('no golden cases found', () => {});
    return;
  }

  for (const c of cases) {
    test(c.name, () => {
      const source = fs.readFileSync(c.sourcePath, 'utf8');
      const expectation = loadExpectation(c.expectedPath);
      const result = runChatter(source);

      if (expectation.error !== null) {
        expect(result.error).not.toBeNull();
        expect(result.error?.message).toContain(expectation.error);
      } else {
        if (result.error) {
          throw new Error(
            `Unexpected error: ${result.error.message}\nStdout so far:\n${result.stdout}`,
          );
        }
        expect(result.stdout).toBe(expectation.stdout);
      }
    });
  }
});
