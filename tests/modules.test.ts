import * as fs from 'fs';
import * as path from 'path';
import { loadProgram } from '../src/moduleLoader';
import { VM } from '../src/vm';

const MODULES_DIR = path.join(__dirname, 'modules');

interface Expectation {
  stdout: string;
  error: string | null;
  warnings: string[] | null;  // null means: don't check warnings
}

function loadExpectation(expectedPath: string, warningsPath: string): Expectation {
  const raw = fs.readFileSync(expectedPath, 'utf8');
  const trimmed = raw.replace(/\n$/, '');
  const firstLine = trimmed.split('\n')[0];
  const errorMatch = /^ERROR:\s*(.*)$/.exec(firstLine);

  let warnings: string[] | null = null;
  if (fs.existsSync(warningsPath)) {
    const wRaw = fs.readFileSync(warningsPath, 'utf8');
    warnings = wRaw.replace(/\n$/, '').split('\n').filter(Boolean);
  }

  if (errorMatch) {
    return { stdout: '', error: errorMatch[1].trim(), warnings };
  }
  return { stdout: trimmed, error: null, warnings };
}

function loadArgs(argsPath: string): string[] {
  if (!fs.existsSync(argsPath)) return [];
  const raw = fs.readFileSync(argsPath, 'utf8');
  // Strip exactly one trailing newline (parallel to .expected handling).
  const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) return [];
  return trimmed.split('\n');
}

function runEntry(entryPath: string, args: string[]): { stdout: string; error: Error | null; warnings: string[] } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(' '));
  };
  try {
    const program = loadProgram(entryPath, { args });
    const warnings = (program.warnings ?? []).map(w => w.message);
    const vm = new VM(program);
    vm.run();
    return { stdout: logs.join('\n'), error: null, warnings };
  } catch (e) {
    return { stdout: logs.join('\n'), error: e as Error, warnings: [] };
  } finally {
    console.log = originalLog;
  }
}

function discoverCases(): Array<{ name: string; entryPath: string; expectedPath: string; warningsPath: string; argsPath: string }> {
  if (!fs.existsSync(MODULES_DIR)) return [];
  const cases: Array<{ name: string; entryPath: string; expectedPath: string; warningsPath: string; argsPath: string }> = [];
  const walk = (dir: string): void => {
    const entryPath = path.join(dir, 'main.chatter');
    const expectedPath = path.join(dir, '.expected');
    const warningsPath = path.join(dir, '.warnings');
    const argsPath = path.join(dir, 'args.txt');
    if (fs.existsSync(entryPath) && fs.existsSync(expectedPath)) {
      cases.push({
        name: path.relative(MODULES_DIR, dir).split(path.sep).join('/'),
        entryPath,
        expectedPath,
        warningsPath,
        argsPath,
      });
      return;
    }
    for (const child of fs.readdirSync(dir)) {
      const childPath = path.join(dir, child);
      if (fs.statSync(childPath).isDirectory()) {
        walk(childPath);
      }
    }
  };
  walk(MODULES_DIR);
  return cases;
}

describe('chatter module golden tests', () => {
  const cases = discoverCases();

  if (cases.length === 0) {
    test.skip('no module cases found', () => {});
    return;
  }

  for (const c of cases) {
    test(c.name, () => {
      const expectation = loadExpectation(c.expectedPath, c.warningsPath);
      const args = loadArgs(c.argsPath);
      const result = runEntry(c.entryPath, args);

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

      if (expectation.warnings !== null) {
        expect(result.warnings).toEqual(expectation.warnings);
      }
    });
  }
});
