'use strict';
// Render the dsh-switchman settings page in every interface locale and save
// element screenshots into the repo's docs/assets/. Kit-only file — the
// package "files" allowlist keeps this directory out of the npm tarball.
//
// Usage:
//   cd docs/render-kit && npm install && node render.cjs
// Prerequisite: a local Chrome (Playwright channel "chrome", with a
// macOS-specific executablePath fallback).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const KIT = __dirname;
const REPO = path.resolve(KIT, '..', '..');
const OUT = path.join(REPO, 'docs', 'assets');

// [locale query param, output filename] — keep in sync with screenshots.json.
const TARGETS = [
	['auto', 'conf-interface.png'],
	['en', 'conf-interface-en.png'],
	['zh-TW', 'conf-interface-zh-TW.png'],
	['ja', 'conf-interface-ja.png'],
	['ko', 'conf-interface-ko.png'],
	['de', 'conf-interface-de.png'],
	['es', 'conf-interface-es.png'],
	['fr', 'conf-interface-fr.png'],
	['it', 'conf-interface-it.png'],
	['pt', 'conf-interface-pt.png'],
	['ru', 'conf-interface-ru.png'],
];

(async () => {
	// Fresh copy of the bundle every run so repo edits are never needed.
	// The copy lands next to page.html (gitignored); page.html loads it by
	// relative src.
	fs.copyFileSync(path.join(REPO, 'client.js'), path.join(KIT, 'client.js'));

	let browser;
	try {
		browser = await chromium.launch({ channel: 'chrome', headless: true });
		console.log('launched chromium via channel "chrome"');
	} catch (error) {
		console.error('channel "chrome" launch failed:', error.message);
		browser = await chromium.launch({
			executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			headless: true,
		});
		console.log('launched chromium via explicit executablePath');
	}

	const context = await browser.newContext({
		viewport: { width: 1000, height: 900 },
		deviceScaleFactor: 2,
	});

	const failures = [];
	for (const [locale, outName] of TARGETS) {
		const page = await context.newPage();
		const pageErrors = [];
		const consoleErrors = [];
		page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		try {
			await page.goto(
				'file://' + path.join(KIT, 'page.html') + '?locale=' + encodeURIComponent(locale),
				{ waitUntil: 'load' },
			);
			await page.waitForFunction(
				() => document.querySelectorAll('[data-dsh-switchman="settings"] section').length >= 5,
				null,
				{ timeout: 10000 },
			);
			await page.waitForTimeout(400); // let fonts and late effects settle
			const element = await page.$('[data-dsh-switchman="settings"]');
			if (!element) throw new Error('settings container not found');
			await element.screenshot({ path: path.join(OUT, outName) });
			const status = pageErrors.length > 0 ? 'RENDERED-BUT-PAGEERROR' : 'OK';
			console.log(status, locale, '->', outName);
			if (pageErrors.length > 0) {
				failures.push({ locale, outName, kind: 'pageerror', errors: pageErrors });
				for (const e of pageErrors) console.error('  pageerror:', e);
			}
		} catch (error) {
			failures.push({
				locale,
				outName,
				kind: 'exception',
				errors: [error.message, ...pageErrors],
			});
			console.error('FAIL', locale, '-', error.message);
			for (const e of pageErrors) console.error('  pageerror:', e);
		}
		if (consoleErrors.length > 0) {
			console.warn('console errors for', locale + ':', consoleErrors.join(' | '));
		}
		await page.close();
	}

	await browser.close();
	fs.writeFileSync(path.join(KIT, 'failures.json'), JSON.stringify(failures, null, 2));
	console.log('done;', failures.length, 'failure(s)');
	process.exit(failures.length > 0 ? 1 : 0);
})().catch((error) => {
	console.error('driver crashed:', error);
	process.exit(2);
});
