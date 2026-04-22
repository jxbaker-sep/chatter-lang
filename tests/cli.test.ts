import { run } from '../src/cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('chatter CLI', () => {
  let errSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('prints usage and exits non-zero when no args', () => {
    const code = run([]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('Usage: chatter <filepath>');
  });

  test('prints error and exits non-zero when file missing', () => {
    const fake = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
    const code = run([fake]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(`File does not exist: ${fake}`);
  });

  test('returns 0 when file contains valid Chatter code', () => {
    const tmp = path.join(os.tmpdir(), `chatter-test-${Date.now()}.chatter`);
    fs.writeFileSync(tmp, '# valid chatter program\n');
    try {
      const code = run([tmp]);
      expect(code).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});