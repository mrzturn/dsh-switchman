// Smoke: parse-check every runtime JS surface. The host suite exercises host/*
// modules by import, but client.js was previously covered by nothing — a syntax
// error there (2026-11-20 cache-adaptive review finding) shipped green. This
// test pins the whole surface with node --check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostDir = path.join(root, 'host');
const surfaces = [
	'client.js',
	'index.js',
	...readdirSync(hostDir)
		.filter((f) => f.endsWith('.js'))
		.map((f) => path.join('host', f)),
];

test('runtime surfaces pass node --check', () => {
	for (const rel of surfaces) {
		const r = spawnSync(process.execPath, ['--check', path.join(root, rel)], {
			encoding: 'utf8',
		});
		assert.equal(r.status, 0, `node --check ${rel} failed:\n${r.stderr}`);
	}
});
