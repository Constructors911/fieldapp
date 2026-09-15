import { chromium, devices } from '../web/node_modules/playwright/index.mjs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, 'onboarding-shots');
const baseURL = process.env.FIELD_APP_URL || 'http://localhost:5173/';

async function shot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(outDir, `${name}.png`),
    animations: 'disabled',
  });
  console.log(`wrote ${name}.png`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...devices['iPhone 14'],
    geolocation: { latitude: 30.3015, longitude: -97.7105 },
    permissions: ['geolocation'],
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(baseURL, { waitUntil: 'load' });
  await page.getByRole('heading', { name: /sign in/i }).waitFor();
  await shot(page, '01-sign-in');

  await page.getByRole('button', { name: /first time/i }).click();
  await page.getByRole('heading', { name: /first time/i }).waitFor();
  await shot(page, '02-register');

  await page.locator('#login-email').fill('david@constructors911.com');
  await page.locator('#login-name').fill('David R.');
  await page.locator('#login-pin').fill('1234');
  await page.getByRole('button', { name: /create & link/i }).click();
  const clockIn = page.getByRole('button', { name: /^clock in$/i });
  const already = page.locator('.login-err');
  try {
    await clockIn.waitFor({ timeout: 8000 });
  } catch {
    if (await already.isVisible()) {
      await page.getByRole('button', { name: /already registered/i }).click();
      await page.locator('#login-email').fill('david@constructors911.com');
      await page.locator('#login-pin').fill('1234');
      await page.getByRole('button', { name: /^sign in$/i }).click();
      await clockIn.waitFor();
    } else {
      throw new Error('Did not reach Clock after register/login');
    }
  }
  await page.getByText('Clocked out').waitFor();
  await shot(page, '03-clock-ready');

  await clockIn.click();
  await page.getByRole('dialog', { name: /pick a job/i }).waitFor();
  await page.getByRole('button', { name: /maplewood kitchen remodel/i }).waitFor();
  await shot(page, '04-pick-job');

  await page.getByRole('button', { name: /maplewood kitchen remodel/i }).click();
  await page.getByRole('dialog', { name: /what are you doing/i }).waitFor();
  await page.getByRole('button', { name: /demolition labor/i }).waitFor();
  await shot(page, '05-pick-activity');

  await page.getByRole('button', { name: /demolition labor/i }).click();
  await page.getByRole('dialog', { name: /ready to clock in/i }).waitFor();
  await shot(page, '06-confirm-clock-in');

  await page.getByRole('dialog').getByRole('button', { name: /^clock in$/i }).click();
  await page.getByText('Clocked in').waitFor();
  await page.getByRole('button', { name: /^clock out$/i }).waitFor();
  await shot(page, '07-clocked-in');

  await page.getByRole('button', { name: /^clock out$/i }).click();
  await page.getByRole('dialog', { name: /clock out/i }).waitFor();
  await page.getByRole('button', { name: /done for the day/i }).waitFor();
  await shot(page, '08-clock-out-choice');

  await page.getByRole('button', { name: /done for the day/i }).click();
  const alreadyLogged = page.getByText(/daily log already submitted/i);
  const doneField = page.getByLabel(/what got done today/i);
  try {
    await doneField.waitFor({ timeout: 4000 });
  } catch {
    if (await alreadyLogged.isVisible()) {
      await page.getByRole('button', { name: /keep working/i }).click();
      await page.getByRole('button', { name: /^clock out$/i }).click();
      await page.getByRole('button', { name: /just a break/i }).click();
      await page.getByRole('button', { name: /confirm clock out/i }).click();
      await page.getByRole('button', { name: /^clock in$/i }).waitFor();
      await page.getByRole('button', { name: /^clock in$/i }).click();
      await page.getByRole('button', { name: /sunset plaza/i }).click();
      await page.getByRole('button', { name: /drywall hang/i }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^clock in$/i }).click();
      await page.getByRole('button', { name: /^clock out$/i }).click();
      await page.getByRole('button', { name: /done for the day/i }).click();
      await doneField.waitFor();
    } else {
      throw new Error('Clock-out log form did not appear');
    }
  }
  await shot(page, '09-clock-out-log');

  await page.getByRole('button', { name: /keep working/i }).click();
  await page.getByRole('tab', { name: /today/i }).click();
  await page.getByRole('heading', { name: /today/i }).waitFor();
  await page.locator('.tdy-name').first().waitFor();
  const expand = page.locator('.tdy-expand').first();
  if (await expand.count()) await expand.click();
  await shot(page, '10-today');

  await page.getByRole('tab', { name: /log/i }).click();
  await page.getByRole('heading', { name: /my daily logs/i }).waitFor();
  const grantCard = page.getByText(/show as you in jobtread/i);
  if (await grantCard.isVisible()) await shot(page, '11-grant-key');
  const notNow = page.getByRole('button', { name: /not now/i });
  if (await notNow.isVisible()) await notNow.click();
  await page.getByText(/maplewood kitchen remodel/i).first().waitFor();
  await shot(page, '11-log-feed');

  await page.getByRole('button', { name: /new log/i }).click();
  await page.getByRole('heading', { name: /new daily log/i }).waitFor();
  await shot(page, '12-new-log');

  await page.getByRole('button', { name: /cancel/i }).click();
  await page.getByRole('tab', { name: /week/i }).click();
  await page.locator('.c-day').first().waitFor();
  await shot(page, '13-week');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
