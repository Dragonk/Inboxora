import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Write-back is a per-collection opt-in, and the switch has to exist on **both** surfaces that show a pulled
 * collection: the calendar sidebar and the address-book menu. The calendar half was built first; the contacts
 * half was missing, which left the address-book write-back reachable only through the REST endpoint.
 *
 * These cases pin the wiring: the button is rendered for a book that has a collection, it is addressed by that
 * collection's id, and it asks for the opposite of the server's current answer.
 */

const page = new URL("./ContactsPage.tsx", import.meta.url);
// The write-back switch is in the manager panel now.
const manager = new URL("./ContactsBooksManager.tsx", import.meta.url);
const api = new URL("../utils/api.ts", import.meta.url);

test("the address-book menu offers the write-back switch for a pulled book", async () => {
  const source = await readFile(manager, "utf8");

  // The switch lives in the manager's Write-back section now, not in the `⋯` menu.
  assert.match(source, /data-testid="contacts-manager-write-back"/);
  // Only a book with a collection can be switched; a local book has nothing to write back to.
  assert.match(source, /selected\.collectionId && \(\s*\n\s*<Button data-testid="contacts-manager-write-back"/);
  // The label states what the click will do, from the server's own verdict.
  assert.match(source, /selected\.readOnly \? 'calendar\.enableWriteBack' : 'calendar\.disableWriteBack'/);
});

test("the switch calls the collection endpoint and reloads the list", async () => {
  const source = await readFile(page, "utf8");
  const handler = source.slice(
    source.indexOf("const toggleAddressBookWriteBack"),
    source.indexOf("const runProviderContactsSync"),
  );
  assert.match(handler, /if \(!book\?\.collection_id\) return;/);
  // The desired state is the opposite of what the server reported, not a locally flipped flag.
  assert.match(handler, /api\.setCollectionWriteBack\(String\(book\.collection_id\), book\.read_only !== false\)/);
  assert.match(handler, /await loadAddressBooks\(\)/);
  // A refusal (for example SOURCE_READ_ONLY) is shown rather than leaving the row looking switched.
  assert.match(handler, /catch \(err\) \{ setListError\(toAppError\(err\)\.message\); \}/);

  const apiSource = await readFile(api, "utf8");
  assert.match(apiSource, /setCollectionWriteBack: \(collectionId: string, writeBack: boolean\) =>/);
});

test("the address-book model carries the collection id and the read-only verdict", async () => {
  const source = await readFile(page, "utf8");
  const model = source.slice(source.indexOf("interface AddressBookRow"), source.indexOf("type AddressBookDavMode"));
  assert.match(model, /collection_id\?: string \| null;/);
  assert.match(model, /read_only\?: boolean;/);
  assert.match(model, /account_id\?: string \| null;/);
  assert.match(model, /account_email\?: string \| null;/);
});

test('a provider-book sync uses its owning account rather than all provider connections', async () => {
  const source = await readFile(page, 'utf8');
  const handler = source.slice(source.indexOf('const runProviderContactsSync'), source.indexOf('const importVCardFile'));
  assert.match(handler, /selectedProviderBook\?\.provider === provider && selectedProviderBook\.account_id/);
  assert.match(handler, /api\.syncAccountProviderFeature\(selectedProviderBook\.account_id, 'contacts'\)/);
});

test('new contacts display and preserve an explicit writable address-book target', async () => {
  const source = await readFile(page, 'utf8');
  assert.match(source, /const \[newAddressBookId, setNewAddressBookId\] = useState\(''\)/);
  assert.match(source, /data-testid="contacts-new-target"/);
  assert.match(source, /addressBooks\.filter\(book => book\.read_only !== true\)/);
  assert.match(source, /addressBookId: newAddressBookId \|\| undefined/);
});
