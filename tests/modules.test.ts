import * as fs from 'fs';
import * as path from 'path';
import { loadProgram } from '../src/moduleLoader';
import { VM } from '../src/vm';

const MODULES_DIR = path.join(__dirname, 'modules');

interface Expectation {
  stdout: string;
  error: string | null;
}

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

function runEntry(entryPath: string): { stdout: string; error: Error | null } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const program = loadProgram(entryPath);
    const vm = new VM(program);
    vm.run();
    return { stdout: logs.join('\n'), error: null };
  } catch (e) {
    return { stdout: logs.join('\n'), error: e as Error };
  } finally {
    console.log = originalLog;
  }
}

function discoverCases(): Array<{ name: string; entryPath: string; expectedPath: string }> {
  if (!fs.existsSync(MODULES_DIR)) return [];
  return fs
    .readdirSync(MODULES_DIR)
    .filter((d) => fs.statSync(path.join(MODULES_DIR, d)).isDirectory())
    .map((d) => ({
      name: d,
      entryPath: path.join(MODULES_DIR, d, 'main.chatter'),
      expectedPath: path.join(MODULES_DIR, d, '.expected'),
    }))
    .filter((c) => fs.existsSync(c.entryPath) && fs.existsSync(c.expectedPath));
}

describe('chatter module golden tests', () => {
  const cases = discoverCases();

  if (cases.length === 0) {
    test.skip('no module cases found', () => {});
    return;
  }

  for (const c of cases) {
    test(c.name, () => {
      const expectation = loadExpectation(c.expectedPath);
      const result = runEntry(c.entryPath);

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
