package io.github.dragonk.inboxora;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small encrypted store for the native push device token.
 *
 * The token is the credential the background workers use to fetch notification
 * details after the WebView session cookie has expired. It is AES-GCM encrypted
 * with a key held in the Android Keystore; the ciphertext lives in a private
 * SharedPreferences file. If the Keystore is unavailable the secret is simply
 * not written — we never fall back to plaintext, and we never copy the user's
 * password into native storage.
 */
final class InboxoraSecretStore {
    private static final String TAG = "InboxoraPush";
    private static final String STORE_NAME = "inboxora-push-secrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "inboxora_push_secrets_v1";
    private static final int GCM_TAG_BITS = 128;

    private InboxoraSecretStore() {}

    static synchronized void put(Context context, String name, String value) {
        if (context == null || name == null) return;
        try {
            if (value == null) {
                prefs(context).edit().remove(name).apply();
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            prefs(context).edit().putString(name, encoded).apply();
        } catch (Exception error) {
            Log.w(TAG, "Could not store a native secret (" + error.getClass().getSimpleName() + ").");
        }
    }

    static synchronized String get(Context context, String name) {
        if (context == null || name == null) return null;
        try {
            String encoded = prefs(context).getString(name, null);
            if (encoded == null) return null;
            String[] parts = encoded.split(":", 2);
            if (parts.length != 2) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                new GCMParameterSpec(GCM_TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP))
            );
            byte[] decrypted = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            return new String(decrypted, StandardCharsets.UTF_8);
        } catch (Exception error) {
            Log.w(TAG, "Could not read a native secret (" + error.getClass().getSimpleName() + ").");
            return null;
        }
    }

    static synchronized void remove(Context context, String name) {
        if (context == null || name == null) return;
        prefs(context).edit().remove(name).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE);
    }

    private static SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
