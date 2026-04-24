export interface SourceLocation {
  line: number;
  col: number;
  length?: number;
}

export class ChatterError extends Error {
  public location?: SourceLocation;
  constructor(message: string, location?: SourceLocation) {
    super(message);
    this.location = location;
  }
}

function hasLocation(e: Error): e is Error & { location?: SourceLocation } {
  return 'location' in (e as object);
}

export function formatError(error: Error, source: string, filename: string): string {
  const fname = filename || '<source>';
  const loc = hasLocation(error) ? error.location : undefined;
  const header = `error: ${error.message}`;

  if (!loc) return header;

  const lines = source.split('\n');
  if (loc.line < 1 || loc.line > lines.length) {
    return `${header}\n --> ${fname}:${loc.line}:${loc.col + 1}`;
  }

  const srcLine = lines[loc.line - 1];
  const lineNumStr = String(loc.line);
  const gutterWidth = lineNumStr.length;
  const gutterPad = ' '.repeat(gutterWidth);
  const caretCol = Math.max(0, loc.col);
  const caretLen = Math.max(1, loc.length ?? 1);
  const caretPad = ' '.repeat(caretCol);
  const carets = '^'.repeat(caretLen);

  // 1-indexed column in the --> line.
  return [
    header,
    `${gutterPad}--> ${fname}:${loc.line}:${loc.col + 1}`,
    `${gutterPad} |`,
    `${lineNumStr} | ${srcLine}`,
    `${gutterPad} | ${caretPad}${carets}`,
  ].join('\n');
}
