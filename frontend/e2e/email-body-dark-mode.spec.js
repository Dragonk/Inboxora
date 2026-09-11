import { test, expect } from './fixtures.js';

// Reading real mail on the dark canvas.
//
// The regression this guards: an earlier rule decided the canvas from "does the message
// contain any colours of its own?", so a single dark footer turned the entire reader
// white in a dark theme. These specs use the shapes of real messages that exposed it.

const DARK = { theme: 'dark_ink', themeMode: 'dark', themeLight: 'ink', themeDark: 'dark_ink' };
const LIGHT = { theme: 'ink', themeMode: 'light', themeLight: 'ink', themeDark: 'dark_ink' };

// A GitHub notification: almost entirely plain text, with one dark grey footer colour.
const GITHUB_LIKE = `<p></p>
<div class="email-fragment">Closed <a href="https://example.test/2428">#2428</a> as completed via <a href="https://example.test/2429">#2429</a>.</div>
<p style="font-size:small;-webkit-text-size-adjust:none;color:#666">&mdash;<br>Reply to this email directly, <a href="https://example.test/x">view it on GitHub</a>, or <a href="https://example.test/y">unsubscribe</a>.<br>You are receiving this because you authored the thread.</p>`;

// An Allegro shipping notice: a light-designed newsletter. White tables, dark text, and
// inner cells that declare no colour of their own.
const ALLEGRO_LIKE = `<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#eceff1"><tbody><tr><td align="center">
<table cellpadding="0" cellspacing="0" border="0" width="600" bgcolor="#ffffff" class="deviceWidth"><tbody>
<tr><td class="deviceWidth" style="padding:16px" align="left"><a href="https://example.test"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="80" alt="Allegro"></a></td></tr>
<tr><td style="font-size:23px;font-family:Roboto, sans-serif;color:#222222;text-align:left;padding:0 16px;line-height:21px">Cześć Kamil,</td></tr>
<tr><td style="font-size:14px;font-family:'Open Sans', sans-serif;color:#222222;text-align:left;padding:16px;line-height:21px">Twoja przesyłka jest gotowa do odbioru w automacie paczkowym.</td></tr>
</tbody></table>
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"><tbody><tr>
<td width="100%" style="padding:16px 16px 6px 16px"><h2 style="font:bold 16px/1.3 Roboto, sans-serif;margin:0 0 8px;color:#222222">Odbierz paczkę</h2>
<p style="font:14px/21px 'Open Sans', sans-serif;color:#222222;margin:0 0 16px">Kod odbioru <b>481 157</b></p>
<p style="font:14px/21px 'Open Sans', sans-serif;color:#222222;margin:0 0 16px"><a href="https://example.test/app" style="color:#00a790;text-decoration:none">OTWÓRZ ZDALNIE</a></p></td>
</tr></tbody></table>
<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#3A4E58"><tbody><tr><td style="padding:16px;color:#ffffff;font-family:Open Sans, sans-serif;font-size:14px;text-align:left">Masz pytania? <a href="https://example.test/help" style="color:#00a790;text-decoration:none">Pomoc Allegro</a></td></tr></tbody></table>
</td></tr></tbody></table>`;

// A ChatGPT-style notice: near-black headings over a transparent background.
const CHATGPT_LIKE = `<h1 style="margin:0;text-align:center;color:#000000;font-family:Helvetica, Arial, sans-serif;font-size:34px">Cytuj liczby w szerszym kontekście</h1>
<p style="margin:0;text-align:center;color:#000000;font-size:16px">Wklej liczbę, twierdzenie lub porównanie.</p>
<p style="color:#0d0d0d;font-size:15px">Czy ten e-mail był przydatny?</p>`;

/**
 * Opens a message and probes the frame. Returns the frame's own surface plus, for every
 * element that renders text, the contrast between its computed colour and the first
 * background actually painted behind it.
 */
async function probe(page, preferences, bodyHtml) {
  page.__preferencesOverride = preferences;
  await page.route('**/api/mail/messages/*/body**', route => route.fulfill({ json: { html: bodyHtml, text: '' } }));
  await page.goto('/?list=0&reader=0');
  await page.locator('[data-msgid]').first().click();
  const frame = page.frameLocator('iframe[sandbox]').first();
  await expect(frame.locator('body')).toBeVisible();

  return page.evaluate(() => {
    const luminance = ([r, g, b]) => {
      const channel = value => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const parse = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const isTransparent = value => !value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent';
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const iframe = document.querySelector('iframe[sandbox]');
    const doc = iframe.contentDocument;
    const htmlStyle = getComputedStyle(doc.documentElement);
    const bodyStyle = getComputedStyle(doc.body);
    const panel = getComputedStyle(iframe.closest('.conversation-message-body-panel') || iframe.parentElement);
    const rootBackground = !isTransparent(htmlStyle.backgroundColor) ? htmlStyle.backgroundColor
      : !isTransparent(bodyStyle.backgroundColor) ? bodyStyle.backgroundColor
        : panel.backgroundColor;

    // The first background painted behind an element, walking up from the element itself.
    const effectiveBackground = element => {
      for (let node = element; node; node = node.parentElement) {
        const background = getComputedStyle(node).backgroundColor;
        if (!isTransparent(background)) return background;
      }
      return rootBackground;
    };

    const samples = [];
    for (const element of doc.body.querySelectorAll('*')) {
      const ownText = [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent.trim())
        .join(' ')
        .trim();
      if (!ownText) continue;
      const colour = getComputedStyle(element).color;
      const background = effectiveBackground(element);
      samples.push({
        text: ownText.slice(0, 40),
        declaredColor: element.style.color || null,
        color: colour,
        background,
        contrast: contrast(colour, background),
      });
    }

    return {
      colorScheme: htmlStyle.colorScheme,
      rootBackground,
      rootLuminance: luminance(parse(rootBackground)),
      bodyContrast: contrast(bodyStyle.color, rootBackground),
      samples,
      // Text our canvas choice would have broken: a hard failure.
      unreadable: samples.filter(sample => sample.contrast < 4.5),
      // Text that is not merely low-contrast but effectively unreadable. A message's own
      // brand colour on its own background is the author's call and is not adapted, so it
      // is held to this floor rather than to 4.5.
      invisible: samples.filter(sample => sample.contrast < 3),
    };
  });
}

test.describe('dark canvas for real message shapes', () => {
  test('a mostly plain message with one dark footer stays dark and readable', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop reader contract');
    await fixtureApi;
    const result = await probe(page, DARK, GITHUB_LIKE);

    // The frame must be the app's dark surface, not a white page.
    expect(result.colorScheme).toBe('dark');
    expect(result.rootLuminance).toBeLessThan(0.2);
    expect(result.unreadable).toEqual([]);
    // The dark footer was lifted rather than left as #666 on a dark canvas.
    const footer = result.samples.find(sample => sample.text.startsWith('—'));
    expect(footer.declaredColor).not.toBe('rgb(102, 102, 102)');
    expect(footer.contrast).toBeGreaterThanOrEqual(4.5);
  });

  test('a light-designed newsletter keeps its cards readable on the dark canvas', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop reader contract');
    await fixtureApi;
    const result = await probe(page, DARK, ALLEGRO_LIKE);

    // The canvas follows the app, while the message keeps the light cards it painted.
    expect(result.colorScheme).toBe('dark');
    expect(result.rootLuminance).toBeLessThan(0.2);
    // Nothing is invisible. This is the floor: the newsletter's own teal-on-white brand
    // link sits at ~3:1 and is the author's choice, so it is not adapted, but no text may
    // be lost to a canvas/text mismatch.
    expect(result.invisible).toEqual([]);

    // A cell inside a white card that declared no colour of its own must be dark, not the
    // app's light default — this is the light-on-white regression.
    const cardHeading = result.samples.find(sample => sample.text.startsWith('Odbierz paczkę'));
    expect(cardHeading.background).toBe('rgb(255, 255, 255)');
    expect(parseFloat(cardHeading.color.match(/[\d.]+/g)[0])).toBeLessThan(120);
    expect(cardHeading.contrast).toBeGreaterThanOrEqual(4.5);

    // A dark band nested INSIDE the light wrapper is its own region: its white text must
    // survive rather than being darkened with the wrapper.
    const darkBand = result.samples.find(sample => sample.text.startsWith('Masz pytania?'));
    expect(darkBand.background).toBe('rgb(58, 78, 88)');
    expect(darkBand.declaredColor).toBe('rgb(255, 255, 255)');
    expect(darkBand.contrast).toBeGreaterThanOrEqual(4.5);

    // ...and a dark link on that band is lifted, because on a dark region it is the text
    // that has to move.
    const bandLink = result.samples.find(sample => sample.text.startsWith('Pomoc Allegro'));
    expect(bandLink.contrast).toBeGreaterThanOrEqual(4.5);
  });

  test('near-black headings over a transparent background are lifted', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop reader contract');
    await fixtureApi;
    const result = await probe(page, DARK, CHATGPT_LIKE);

    expect(result.colorScheme).toBe('dark');
    expect(result.unreadable).toEqual([]);
    for (const sample of result.samples) {
      // None of the original near-black declarations may survive onto the dark canvas.
      expect(sample.declaredColor).not.toMatch(/rgb\((0|13),/);
      expect(sample.contrast).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the light appearance is untouched by the adaptation', async ({ page, fixtureApi }) => {
    test.skip(page.viewportSize().width < 768, 'desktop reader contract');
    await fixtureApi;
    const result = await probe(page, LIGHT, CHATGPT_LIKE);

    expect(result.colorScheme).toBe('light');
    expect(result.unreadable).toEqual([]);
    // On a light canvas the message's own dark text is already correct and must not move.
    const heading = result.samples.find(sample => sample.text.startsWith('Cytuj liczby'));
    expect(heading.declaredColor).toBe('rgb(0, 0, 0)');
  });
});
