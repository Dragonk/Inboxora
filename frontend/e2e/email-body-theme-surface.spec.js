import { test, expect } from './fixtures.js';

// The mail body is its own document inside a sandboxed iframe, so it cannot inherit
// the app's colour tokens and its user-agent default text colour follows the
// operating system. A message that declares no colours of its own must still be
// legible on the surface it actually sits on — this is the black-on-dark regression.
//
// The fixture bodies are exactly that case: a bare <p> with no colour declarations.

/** Opens the first message and returns a probe of the frame's resolved surface. */
async function measureEmailSurface(page, preferences, { bodyHtml = null } = {}) {
  page.__preferencesOverride = preferences;
  if (bodyHtml) {
    await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: bodyHtml, text: '' } }));
  }
  await page.goto('/?list=0&reader=0');
  await page.locator('[data-msgid]').first().click();
  const frame = page.frameLocator('iframe[sandbox]').first();
  await expect(frame.locator('body')).toBeVisible();
  return page.evaluate(() => {
    // Relative luminance + WCAG contrast, computed against the server-rendered values.
    const luminance = ([r, g, b]) => {
      const channel = value => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const parse = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const iframe = document.querySelector('iframe[sandbox]');
    const doc = iframe.contentDocument;
    const bodyStyle = getComputedStyle(doc.body);
    const htmlStyle = getComputedStyle(doc.documentElement);
    // Resolve the frame's own painted background: the body's if declared, else the root's.
    const bodyBg = bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      ? htmlStyle.backgroundColor
      : bodyStyle.backgroundColor;
    const background = bodyBg === 'rgba(0, 0, 0, 0)'
      // Transparent means the surrounding panel shows through — measure that instead.
      ? getComputedStyle(iframe.closest('.conversation-message-body-panel') || iframe.parentElement).backgroundColor
      : bodyBg;
    const text = bodyStyle.color;
    return {
      colorScheme: htmlStyle.colorScheme,
      background,
      text,
      contrast: contrast(text, background),
      textLuminance: luminance(parse(text)),
      backgroundLuminance: luminance(parse(background)),
    };
  });
}

const LIGHT = { theme: 'ink', themeMode: 'light', themeLight: 'ink', themeDark: 'dark_ink' };

/** The resolved colour, background and contrast of one element inside the message frame. */
async function measureElement(page, selector) {
  return page.evaluate(selectorValue => {
    const luminance = ([r, g, b]) => {
      const channel = value => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const parse = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const transparent = value => !value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent';
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const doc = document.querySelector('iframe[sandbox]').contentDocument;
    const element = doc.querySelector(selectorValue);
    if (!element) return null;
    let background = null;
    for (let node = element; node; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor;
      if (!transparent(value)) { background = value; break; }
    }
    const color = getComputedStyle(element).color;
    return { declaredColor: element.style.color || null, color, background, contrast: contrast(color, background) };
  }, selector);
}
const DARK = { theme: 'dark_ink', themeMode: 'dark', themeLight: 'ink', themeDark: 'dark_ink' };

test.describe('mail body surface follows the app theme', () => {
  test('an unstyled message stays legible on the dark appearance', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop parent-row selection contract');
    await fixtureApi;
    const surface = await measureEmailSurface(page, DARK);

    // The frame declares the app's appearance, so UA defaults stop following the OS.
    expect(surface.colorScheme).toBe('dark');
    // The body really is a dark surface...
    expect(surface.backgroundLuminance).toBeLessThan(0.2);
    // ...and the default text on it is light, not the black user-agent default.
    expect(surface.textLuminance).toBeGreaterThan(0.5);
    expect(surface.contrast).toBeGreaterThanOrEqual(4.5);
  });

  test('the light appearance keeps dark text on the light surface', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop parent-row selection contract');
    await fixtureApi;
    const surface = await measureEmailSurface(page, LIGHT);

    expect(surface.colorScheme).toBe('light');
    expect(surface.backgroundLuminance).toBeGreaterThan(0.5);
    expect(surface.textLuminance).toBeLessThan(0.2);
    expect(surface.contrast).toBeGreaterThanOrEqual(4.5);
  });

  // The reported regression: the message paints its own light card but declares no text
  // colour. The canvas must stay dark — the app's light default text used to land on that
  // white card. The card keeps its own background and gains an adapted dark text colour;
  // per-element contrast is covered in depth by email-body-dark-mode.spec.js.
  test('a message with its own light background keeps dark, readable text', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop parent-row selection contract');
    await fixtureApi;
    const surface = await measureEmailSurface(page, DARK, {
      bodyHtml: '<table width="100%" style="background-color:#F7F7F7"><tbody><tr><td style="background-color:#FFFFFF"><div>Witaj Kamil Maciąg</div></td></tr></tbody></table>',
    });

    // The frame stays on the app's dark canvas...
    expect(surface.colorScheme).toBe('dark');
    expect(surface.backgroundLuminance).toBeLessThan(0.2);

    // ...while the message's own white card carries dark, readable text.
    const card = await measureElement(page, 'td[style*="background-color:#FFFFFF"]');
    expect(card.background).toBe('rgb(255, 255, 255)');
    expect(card.contrast).toBeGreaterThanOrEqual(4.5);
  });

  test('a message with hard-coded black text on a transparent background stays readable', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop parent-row selection contract');
    await fixtureApi;
    // Black text with no background of its own assumes a white page; on the dark canvas the
    // text is lifted rather than the whole reader being repainted white.
    const surface = await measureEmailSurface(page, DARK, {
      bodyHtml: '<h1 style="color:#000000">Tytuł</h1><p style="color: rgb(13, 13, 13)">Treść</p>',
    });

    expect(surface.colorScheme).toBe('dark');
    expect(surface.backgroundLuminance).toBeLessThan(0.2);

    const heading = await measureElement(page, 'h1');
    expect(heading.declaredColor).not.toMatch(/rgb\(0, 0, 0\)/);
    expect(heading.contrast).toBeGreaterThanOrEqual(4.5);
  });

  test('the frame background matches the panel it sits in', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop parent-row selection contract');
    await fixtureApi;
    const surface = await measureEmailSurface(page, DARK);
    const panel = await page.evaluate(() => {
      const panel = document.querySelector('.conversation-message-body-panel');
      return getComputedStyle(panel).backgroundColor;
    });
    // An explicit frame background must not introduce a visible seam against the panel
    // that already painted the same token.
    expect(surface.background).toBe(panel);
  });
});
