package com.artemis.helper;

/** Accepts only the desktop's existing token format for user-entered pairing. */
final class InspectorPairingToken {
    private InspectorPairingToken() {}

    static boolean setFromUser(String value) {
        if (value == null || value.length() < 16 || value.length() > 256) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z')
                    && !(c >= '0' && c <= '9') && c != '_' && c != '-') return false;
        }
        TokenStore.set(value);
        return true;
    }

    static void clearFromUser() {
        TokenStore.set(null);
    }
}
