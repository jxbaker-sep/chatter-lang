#!/usr/bin/env node
import { run } from './cli';

const code = run(process.argv.slice(2));
process.exit(code);