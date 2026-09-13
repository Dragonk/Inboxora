export async function selectCalendarView(page, view) {
  if (page.viewportSize().width < 768) await page.getByTestId('calendar-view-select').selectOption(view);
  else await page.getByTestId(`calendar-view-${view}`).click();
}
export async function returnToMail(page) {
  if (page.viewportSize().width < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByText('Gmail fixture', { exact: true }).click();
}
export async function openContactBooks(page) {
  if (page.viewportSize().width < 768) await page.getByTestId('contacts-address-books').click();
}
// Panels can animate in (the narrow-screen bottom sheets slide up). Measuring a
// panel's box mid-animation reads a transformed position, so geometry contracts
// wait for CSS animations to settle first. Infinite animations (spinners) are
// ignored, since they legitimately never finish.
export async function settleAnimations(page) {
  await page.waitForFunction(() => document.getAnimations().every(
    animation => animation.effect?.getComputedTiming().endTime === Infinity || animation.playState !== 'running',
  ));
}
