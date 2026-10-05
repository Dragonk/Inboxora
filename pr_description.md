🧪 Add test for malformed expandedAccounts JSON in localStorage

🎯 **What:** Replaced the generic `index.test.ts` file with a specific `expandedAccounts.test.ts` to correctly test the error handling behavior when `localStorage` returns a malformed JSON string for `mailflow_expanded_accounts`. The test uses a cache-busting query parameter in a dynamic import to ensure the store module initialization executes under the mocked conditions, resolving the gap in test coverage.

📊 **Coverage:** Tests that when `JSON.parse(localStorage.getItem('mailflow_expanded_accounts'))` throws an error due to invalid JSON (e.g., `{"malformed": }`), the store correctly catches the error and initializes `expandedAccounts` to an empty object `{}`.

✨ **Result:** A functioning test for this specific initialization logic that verifies the safety net against corrupted local storage, replacing an inert/flawed test attempt.
