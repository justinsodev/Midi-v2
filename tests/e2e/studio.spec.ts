import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
async function room(browser: Browser, reliable = false) {
  const contexts: BrowserContext[] = []; const pages: Page[] = [];
  for (const name of ['Alice', 'Bob', 'Cara']) {
    const context = await browser.newContext(); contexts.push(context); const page = await context.newPage(); pages.push(page);
    await page.goto(pages.length === 1 ? '/' : pages[0].url());
    await page.getByLabel('Your name', { exact: true }).fill(name);
    if (pages.length === 1) {
      if (reliable) await page.getByLabel('Delivery experiment').selectOption('reliable');
      await page.getByRole('button', { name: 'Create studio' }).click();
    } else await page.getByRole('button', { name: 'Enable audio & join studio' }).click();
    await expect(page.getByTestId('audio-state')).toContainText('Audio ready');
  }
  for (const page of pages) { await expect(page.getByTestId('peer-count')).toHaveText('2', { timeout: 20000 }); }
  return { contexts, pages };
}
for (const reliable of [false, true]) test(`three musicians exchange notes in all six directions (${reliable ? 'reliable' : 'fast'})`, async ({ browser }) => {
  const { contexts, pages } = await room(browser, reliable);
  try {
    const errors: string[] = []; for (const page of pages) page.on('pageerror', error => errors.push(error.message));
    for (let sender = 0; sender < pages.length; sender++) {
      const key = pages[sender].getByTestId('note-0'); await key.focus(); await key.press('Enter');
      for (let receiver = 0; receiver < pages.length; receiver++) if (receiver !== sender) {
        const previous = sender === 0 ? 0 : receiver < sender ? sender - 1 : sender;
        await expect(pages[receiver].getByTestId('received-notes')).toHaveText(String(previous + 1));
      }
    }
    for (const page of pages) { await expect(page.getByTestId('received-notes')).toHaveText('2'); await expect(page.getByTestId('active-voices')).toHaveText('0'); }
    await pages[2].getByRole('button', { name: 'Leave studio' }).click();
    for (const page of pages.slice(0, 2)) await expect(page.getByTestId('peer-count')).toHaveText('1');
    await pages[2].getByRole('button', { name: 'Enable audio & join studio' }).click();
    for (const page of pages) await expect(page.getByTestId('peer-count')).toHaveText('2');
    expect(errors).toEqual([]);
  } finally { for (const context of contexts) await context.close(); }
});
test('renders a held remote note and recovers its lost release', async ({ browser }) => {
  const { contexts, pages } = await room(browser);
  try {
    await pages[0].getByTestId('note-0').focus(); await pages[0].keyboard.down('Enter');
    await expect(pages[1].getByTestId('active-voices')).toHaveText('1');
    await pages[1].getByLabel('Injected receive loss').selectOption('100');
    await pages[0].keyboard.up('Enter');
    // Every release packet is dropped; the reliable state journal must repair it.
    await expect(pages[1].getByTestId('active-voices')).toHaveText('0', { timeout: 5000 });
    await expect(pages[2].getByTestId('active-voices')).toHaveText('0');
    await pages[0].getByTestId('note-0').focus(); await pages[0].keyboard.down('Enter');
    await expect(pages[2].getByTestId('active-voices')).toHaveText('1');
    await contexts[0].close(); await expect(pages[2].getByTestId('active-voices')).toHaveText('0');
    await expect(pages[2].getByTestId('peer-count')).toHaveText('1');
  } finally { for (const context of contexts) await context.close(); }
});
test('fast redundancy withstands reproducible five-percent receive loss', async ({ browser }, testInfo) => {
  const { contexts, pages } = await room(browser);
  try {
    await pages[1].getByLabel('Injected receive loss').selectOption('5');
    await pages[2].getByLabel('Injected receive loss').selectOption('5');
    await pages[0].getByRole('button', { name: 'Send 100-note test' }).click();
    for (const page of pages.slice(1)) { await expect(page.getByTestId('received-notes')).toHaveText('100', { timeout: 20000 }); await expect(page.getByTestId('active-voices')).toHaveText('0'); }
  } catch (error) {
    // Preserve counters to distinguish skipped late onsets from packet loss.
    for (let index = 0; index < pages.length; index++) {
      await testInfo.attach(`musician-${index}-diagnostics`, { body: await pages[index].locator('.diagnostics').innerText(), contentType: 'text/plain' }).catch(() => {});
    }
    throw error;
  } finally { for (const context of contexts) await context.close(); }
});
test('requires a name and explains unavailable forced TURN', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Create studio' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter your name');
  await page.getByLabel('Your name', { exact: true }).fill('Justin'); await page.getByLabel('Force TURN relay').check();
  await page.getByRole('button', { name: 'Create studio' }).click(); await expect(page.getByRole('alert')).toContainText('Forced relay needs');
});
