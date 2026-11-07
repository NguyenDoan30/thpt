const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestServer, prepareAuthenticatedPage } = require('./auth-fixture.cjs');

const AVATAR_KEY = 'thpt-an-binh-school-avatar-v1';
const YEARS_KEY = 'thpt-an-binh-school-years-v1';
const DATA_KEY = 'thpt-an-binh-data-v1';

async function run() {
  const server = await startTestServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const mobile = viewport.width < 500;
      const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://fonts.googleapis.com/**', route => route.abort());
      await page.route('https://fonts.gstatic.com/**', route => route.abort());
      await prepareAuthenticatedPage(page, server.origin);
      if (mobile) await page.locator('#mobileMenu').click();

      const button = page.locator('#schoolAvatarButton');
      const input = page.locator('#schoolAvatarInput');
      const image = page.locator('#schoolAvatarImage');
      assert.equal(await button.getAttribute('type'), 'button');
      assert.ok(await button.getAttribute('aria-label'), 'Avatar picker needs an accessible label');
      assert.equal(await input.getAttribute('accept'), 'image/*');
      assert.equal(await input.getAttribute('capture'), null, 'Picker should permit the image library, not force a camera');
      assert.equal(await image.isVisible(), false);

      const fixture = async (type, alternate = false) => {
        const url = await page.evaluate(({ type, alternate }) => {
          const canvas = document.createElement('canvas');
          canvas.width = 768;
          canvas.height = 256;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 256, 256);
          ctx.fillStyle = alternate ? '#ffff00' : '#00ff00'; ctx.fillRect(256, 0, 256, 256);
          ctx.fillStyle = '#0000ff'; ctx.fillRect(512, 0, 256, 256);
          return canvas.toDataURL(type);
        }, { type, alternate });
        return Buffer.from(url.split(',')[1], 'base64');
      };
      const png = { name: 'school-logo.png', mimeType: 'image/png', buffer: await fixture('image/png') };
      const jpeg = { name: 'school-photo.jpg', mimeType: 'image/jpeg', buffer: await fixture('image/jpeg', true) };
      const state = () => page.evaluate(({ yearsKey, dataKey }) => ({ data, schoolYears, teachers: globalTeachers, yearsStored: localStorage.getItem(yearsKey), dataStored: localStorage.getItem(dataKey) }), { yearsKey: YEARS_KEY, dataKey: DATA_KEY });
      const avatar = () => page.evaluate(key => localStorage.getItem(key), AVATAR_KEY);
      const settled = () => page.waitForFunction(() => document.querySelector('#schoolAvatarInput').value === '' && !document.querySelector('#schoolAvatarButton').disabled);
      const choose = async (file, keyboard = false) => {
        const chooserPromise = page.waitForEvent('filechooser');
        if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); }
        else if (mobile) await button.tap();
        else await button.click();
        const chooser = await chooserPromise;
        await chooser.setFiles(file);
        await settled();
      };
      const assertAvatar = async expected => {
        assert.equal(await avatar(), expected);
        assert.equal(await image.getAttribute('src'), expected);
        assert.equal(await image.isVisible(), true);
      };
      const original = await state();

      // A real keyboard click opens the native picker; output crops the middle square.
      await choose(png, true);
      const first = await avatar();
      assert.ok(first && first.startsWith('data:image/png;base64,'));
      await assertAvatar(first);
      const pixels = await page.evaluate(async dataUrl => {
        const image = new Image(); image.src = dataUrl; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, corner: [...ctx.getImageData(1, 1, 1, 1).data], center: [...ctx.getImageData(128, 128, 1, 1).data] };
      }, first);
      assert.deepEqual(pixels, { width: 256, height: 256, corner: [0, 255, 0, 255], center: [0, 255, 0, 255] });
      assert.deepEqual(await state(), original, 'Changing school avatar must not modify academic data or its storage');

      // PNG/JPEG replacement and choosing the same file again work through the picker.
      await choose(jpeg);
      const second = await avatar(); assert.notEqual(second, first); await assertAvatar(second);
      await choose(jpeg); await assertAvatar(second);
      await choose(png); await assertAvatar(first);

      // Empty selection, bad MIME, invalid image bytes and oversize input preserve the prior image.
      await input.setInputFiles([]); await settled(); await assertAvatar(first);
      for (const file of [
        { name: 'not-image.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
        { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid PNG bytes') },
        { name: 'oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
      ]) {
        await input.setInputFiles(file); await settled(); await assertAvatar(first);
      }

      // Storage failure cannot apply an image that would disappear after reloading.
      await page.evaluate(key => {
        const original = Storage.prototype.setItem;
        window.restoreAvatarStorage = () => { Storage.prototype.setItem = original; };
        Storage.prototype.setItem = function(name, value) {
          if (name === key) throw new DOMException('Fixture quota failure', 'QuotaExceededError');
          return original.call(this, name, value);
        };
      }, AVATAR_KEY);
      await input.setInputFiles(jpeg); await settled(); await assertAvatar(first);
      await page.evaluate(() => window.restoreAvatarStorage());
      assert.deepEqual(await state(), original);

      await page.reload(); await page.locator('#appRoot').waitFor({ state: 'visible' }); if (mobile) await page.locator('#mobileMenu').click();
      await assertAvatar(first);
      await page.locator('#academicYearButton').click();
      await page.locator('#f-startYear').fill('2027'); await page.locator('#f-endYear').fill('2028');
      await page.locator('#copySchoolYear').uncheck();
      await page.getByRole('button', { name: 'Tạo năm học', exact: true }).click();
      await assertAvatar(first);
      await page.locator('#academicYearButton').click();
      await page.locator('[data-action="select-school-year"][data-year="2026-2027"]').click();
      await assertAvatar(first);
      await page.reload(); await page.locator('#appRoot').waitFor({ state: 'visible' }); if (mobile) await page.locator('#mobileMenu').click(); await assertAvatar(first);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: native/keyboard image picker, square PNG conversion, JPEG/reselection, validation and quota recovery, reload/year persistence, academic data unchanged.`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
