package com.artemis.helper;

public final class InspectorPairingTokenCheck {
    private static void require(boolean accepted, String message) {
        if (!accepted) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        String valid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        require(InspectorPairingToken.setFromUser(valid), "valid desktop token should pair");
        require(TokenStore.matches(valid), "token should be applied to the existing store");
        StringBuilder tooLong = new StringBuilder();
        for (int i = 0; i < 257; i++) tooLong.append('a');
        for (String invalid : new String[] {
                null, "", "short", "123456789012345 ", "123456789012345\n",
                "123456789012345中", "123456789012345/", tooLong.toString()
        }) {
            require(!InspectorPairingToken.setFromUser(invalid), "invalid token must be rejected");
            require(TokenStore.matches(valid), "invalid token must not modify the active pairing");
        }
        require(InspectorPairingToken.setFromUser("AbCdEfGh123456_-"), "desktop token alphabet");
        require(!TokenStore.matches(valid), "pairing should replace the old token");
        InspectorPairingToken.clearFromUser();
        require(!TokenStore.isSet(), "manual clearing must revoke the token");
        System.out.println("manual pairing validation and revocation passed");
    }
}
