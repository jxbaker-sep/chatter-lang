export interface SourceLocation {
  line: number;
  col: number;
  length?: number;
  file?: string;
}

export class ChatterError extends Error {
  public location?: SourceLocation;
  constructor(message: string, location?: SourceLocation) {
    super(message);
    this.location = location;
  }
}

// Aggregates multiple compile-time diagnostics into a single throwable. The
// CLI / formatError unpacks it and renders each inner error individually.
export class AggregateChatterError extends Error {
  constructor(public errors: ChatterError[]) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'AggregateChatterError';
  }
}

function hasLocation(e: Error): e is Error & { location?: SourceLocation } {
  return 'location' in (e as object);
}

export function formatError(error: Error, source: string, filename: string): string {
  if (error instanceof AggregateChatterError) {
    return error.errors.map((e) => formatError(e, source, filename)).join('\n\n');
  }
  const fname = filename || '<source>';
  const loc = hasLocation(error) ? error.location : undefined;
  const header = `error: ${error.message}`;

  if (!loc) return header;

  // If de loc came from a different file than the entry source we have access
  // to (e.g. an imported stdlib module), don't render a misleading source-line
  // caret — just print the right filename + line:col.
  if (loc.file && loc.file !== filename) {
    return `${header}\n --> ${loc.file}:${loc.line}:${loc.col + 1}`;
  }

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
