# Chatter — VS Code extension

Syntax highlighting for the [Chatter](../README.md) programming language.

## Features

- Highlighting for all reserved keywords, types, operators, and built-ins
- Multi-word operator phrases (`is less than or equal to`, `is at most`, etc.)
- Special highlighting for the meta-variable `it`
- Function names at declaration and call sites
- `#` line comments
- String literals with escape-sequence hints
- Auto-indentation for `function`/`if`/`repeat` blocks
- Auto-closing of `"` and `(`

## Install locally (development)

```bash
cp -r vscode-chatter ~/.vscode/extensions/chatter-0.1.0
# then reload VS Code
```

Or, from inside the `vscode-chatter/` directory:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension chatter-0.1.0.vsix
```

## File association

Files ending in `.chatter` are automatically recognized. If you need to force
the language on an untitled file, use `⇧⌘P → Change Language Mode → Chatter`.

## Status

Version 0.1.0 — purely syntactic. No diagnostics, no LSP, no formatter. Future
work: a language server that reuses the real Chatter compiler/VM for proper
error squigglies.
