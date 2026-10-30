package com.androiduiinspector.sample;

/** Its Debug manifest disables acceleration at the window level. */
public final class SoftwareTextActivity extends HardwareTextActivity {
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        // Debug fixture only: the owning app UID can change its own Provider
        // state on devices which refuse shell component changes.
        if (getIntent().hasExtra("inspectorProviderEnabled")) {
            boolean enabled = getIntent().getBooleanExtra("inspectorProviderEnabled", true);
            getPackageManager().setComponentEnabledSetting(
                    new android.content.ComponentName(this, "com.androiduiinspector.sdk.HierarchyProvider"),
                    enabled ? android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                            : android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    android.content.pm.PackageManager.DONT_KILL_APP);
        }
    }
}
