const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer, installAuthMocks, AUTH_STORAGE_KEY, EMAIL, PASSWORD } = require('./auth-fixture.cjs');

const appVisible = page => page.locator('#appRoot').isVisible();
async function ready(page) { await page.waitForFunction(() => !document.querySelector('#loginSubmit').disabled); }
async function errorShown(page) { await page.waitForFunction(() => document.querySelector('#loginError').textContent.trim()); }
async function waitUntil(condition) {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the auth server fixture');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function run() {
  const server = await startTestServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const auth = await installAuthMocks(page);
      await page.addInitScript(() => {
        window.__appShownBeforeLogin = false;
        window.__loginAllowed = false;
        new MutationObserver(() => {
          const app = document.getElementById('appRoot');
          if (app && !app.hidden && !window.__loginAllowed) window.__appShownBeforeLogin = true;
        }).observe(document, { subtree: true, attributes: true, childList: true });
      });
      await page.goto(server.origin); await ready(page);
      assert.equal(await appVisible(page), false);
      assert.equal(await page.locator('#authScreen').isVisible(), true);
      assert.equal(await page.evaluate(() => window.__appShownBeforeLogin), false, 'Dashboard must not flash before login');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const original = await page.evaluate(() => JSON.stringify({ data, schoolYears, schoolName: localStorage.getItem(SCHOOL_NAME_KEY), avatar: localStorage.getItem(AVATAR_KEY), years: localStorage.getItem(YEARS_KEY), legacy: localStorage.getItem(KEY) }));

      // Invalid email remains native form validation and never sends credentials.
      await page.locator('#loginEmail').fill('invalid-email'); await page.locator('#loginPassword').fill(PASSWORD);
      await page.locator('#loginSubmit').click();
      assert.equal(auth.counts.password, 0);
      assert.equal(await appVisible(page), false);
      await page.locator('#loginEmail').fill(EMAIL);
      await page.locator('#loginPasswordToggle').click(); assert.equal(await page.locator('#loginPassword').getAttribute('type'), 'text');
      await page.locator('#loginPasswordToggle').click(); assert.equal(await page.locator('#loginPassword').getAttribute('type'), 'password');

      // Server rejects incorrect passwords; no local credential check or dashboard bypass.
      await page.locator('#loginPassword').fill('Wrong-password-123!'); await page.locator('#loginSubmit').click(); await errorShown(page);
      assert.equal(auth.counts.password, 1); assert.equal(await appVisible(page), false);
      assert.equal(await page.evaluate(() => window.__appShownBeforeLogin), false);
      await page.evaluate(() => { window.__loginAllowed = true; });
      await auth.signIn();
      assert.ok(auth.counts.user > 0, 'Successful login must verify the user with the auth server');
      assert.equal(await page.locator('#authScreen').isVisible(), false);
      assert.equal(await page.locator('#loginPassword').inputValue(), '');
      assert.equal(await page.locator('#currentAccountName').textContent(), EMAIL);
      assert.equal(await page.evaluate(() => JSON.stringify({ data, schoolYears, schoolName: localStorage.getItem(SCHOOL_NAME_KEY), avatar: localStorage.getItem(AVATAR_KEY), years: localStorage.getItem(YEARS_KEY), legacy: localStorage.getItem(KEY) })), original, 'Logging in must preserve school data and branding');

      // Restoring a browser session stays closed until /user confirms it.
      auth.holdUser = true; const beforeRestore = auth.counts.user;
      await page.reload(); await waitUntil(() => auth.counts.user > beforeRestore);
      assert.equal(await appVisible(page), false, 'A stored token alone must not unlock the app');
      auth.releaseUser(); await page.locator('#appRoot').waitFor({ state: 'visible' });

      // An expired access token refreshes through the real SDK, then gets verified.
      await page.evaluate(key => {
        const saved = JSON.parse(localStorage.getItem(key));
        saved.expires_at = Math.floor(Date.now() / 1000) - 60;
        localStorage.setItem(key, JSON.stringify(saved));
      }, AUTH_STORAGE_KEY);
      const beforeRefresh = auth.counts.refresh;
      await page.reload(); await page.locator('#appRoot').waitFor({ state: 'visible' });
      assert.ok(auth.counts.refresh > beforeRefresh, 'Expired sessions must refresh with the auth server');

      if (viewport.width < 500) await page.locator('#mobileMenu').click();
      await page.locator('#logoutButton').click();
      await page.locator('#authScreen').waitFor({ state: 'visible' });
      assert.equal(await appVisible(page), false); assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.locator('#loginPassword').inputValue(), '');
      assert.equal(auth.counts.logout, 1);
      assert.equal(await page.evaluate(() => JSON.stringify({ data, schoolYears, schoolName: localStorage.getItem(SCHOOL_NAME_KEY), avatar: localStorage.getItem(AVATAR_KEY), years: localStorage.getItem(YEARS_KEY), legacy: localStorage.getItem(KEY) })), original);
      await page.reload(); await ready(page); assert.equal(await appVisible(page), false);
      await auth.signIn();

      // A revoked account and unavailable verification server both fail closed on reload.
      auth.revoked = true; await page.reload(); await errorShown(page); assert.equal(await appVisible(page), false);
      auth.revoked = false; await auth.signIn();
      auth.userNetworkError = true; await page.reload(); await errorShown(page); assert.equal(await appVisible(page), false);
      auth.userNetworkError = false;
      await auth.signIn();
      if (viewport.width < 500) await page.locator('#mobileMenu').click();
      auth.logoutNetworkError = true;
      await page.locator('#logoutButton').click(); await errorShown(page);
      assert.equal(await appVisible(page), false, 'A network failure during logout must still lock the screen');
      await page.reload(); await ready(page);
      assert.equal(await appVisible(page), false, 'A leftover token must not reopen a manually locked session after reload');
      auth.logoutNetworkError = false;
      await auth.signIn();
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: pre-login gate, server credentials, verified restore/refresh, logout, revoked/network failures, unchanged school data.`);
      await context.close();
    }

    // A verified screen must close at token expiry even while refresh requests fail offline.
    {
      const page = await browser.newPage();
      const auth = await installAuthMocks(page, { accessLifetime: 3 });
      await page.goto(server.origin); await auth.signIn();
      const verifiedBeforeExpiry = auth.counts.user;
      auth.tokenNetworkError = true;
      await page.locator('#appRoot').waitFor({ state: 'hidden', timeout: 7000 });
      assert.equal(await page.locator('#authScreen').isVisible(), true);
      await waitUntil(() => auth.counts.failedRefresh > 0);
      assert.equal(await appVisible(page), false, 'Offline refresh failure must not reopen expired access');
      auth.accessLifetime = 3600;
      auth.tokenNetworkError = false;
      await page.locator('#appRoot').waitFor({ state: 'visible', timeout: 15000 });
      assert.ok(auth.counts.refresh > 0, 'Expired access must refresh against the server');
      assert.ok(auth.counts.user > verifiedBeforeExpiry, 'The replacement session must be verified before reopening');
      await page.close();
      console.log('PASS: offline expiry locks the dashboard until a refreshed session is verified.');
    }

    // Missing deployment configuration or blocked SDK never reveals the existing dashboard.
    for (const options of [{ missingConfig: true }, { sdkFailure: true }]) {
      const page = await browser.newPage(); await installAuthMocks(page, options); await page.goto(server.origin);
      await errorShown(page); assert.equal(await appVisible(page), false); assert.equal(await page.locator('#loginSubmit').isDisabled(), true);
      await page.close();
    }
    console.log('PASS: missing configuration and SDK load failure stay locked.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
