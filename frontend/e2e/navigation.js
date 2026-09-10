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
