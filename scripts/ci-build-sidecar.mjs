#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const taskRoot = fileURLToPath(new URL('../', import.meta.url));
const taskTarget = process.argv[2];
const targets = {
  'aarch64-apple-darwin': ['darwin', 'arm64', ''],
  'x86_64-apple-darwin': ['darwin', 'amd64', ''],
  'x86_64-unknown-linux-gnu': ['linux', 'amd64', ''],
  'x86_64-pc-windows-msvc': ['windows', 'amd64', '.exe'],
};
if (!Object.hasOwn(targets, taskTarget)) {
  console.error('Pass a supported Rust target triple: ' + Object.keys(targets).join(', '));
  process.exit(2);
}
const [GOOS, GOARCH, extension] = targets[taskTarget];
const binaryDirectory = path.join(taskRoot, 'apps/client/src-tauri/binaries');
mkdirSync(binaryDirectory, { recursive: true });
const output = path.join(binaryDirectory, `space-gateway-${taskTarget}${extension}`);
const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', output, './cmd/space-gateway'], {
  cwd: path.join(taskRoot, 'server'),
  env: { ...process.env, CGO_ENABLED: '0', GOOS, GOARCH },
  stdio: 'inherit',
});
if (result.error) { console.error('Could not start the Go compiler'); process.exit(1); }
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Built ${path.relative(taskRoot, output)} (${GOOS}/${GOARCH}, CGO disabled)`);
