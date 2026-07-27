# macOS code signing & notarization

`npm run dist` produces signed **and** notarized DMGs automatically **when the
credentials below are present**. With none present it falls back to the current
behaviour: an unsigned build (users must right-click → Open once). No code
changes are needed to switch between the two — it's all environment-driven.

Two independent things are required for a Gatekeeper-clean app:

1. **Signing** — a *Developer ID Application* certificate (Apple Developer
   Program, $99/yr). electron-builder applies it during packaging.
2. **Notarization** — Apple scans the signed app and issues a ticket that gets
   stapled into it. Handled by `scripts/notarize.js` (afterSign hook).

## 1. Signing certificate

Get a **Developer ID Application** cert from
<https://developer.apple.com/account/resources/certificates>, then either:

- **Local machine:** double-click the downloaded `.cer` (plus its private key)
  to import into the login keychain. electron-builder auto-discovers it — nothing
  else to configure.
- **CI / headless:** export the cert + key as a `.p12` and set:
  ```sh
  export CSC_LINK=/absolute/path/to/DeveloperID.p12   # or a base64 string
  export CSC_KEY_PASSWORD='the .p12 password'
  ```

Verify a cert is visible: `security find-identity -v -p codesigning`

## 2. Notarization — App Store Connect API key (standard here)

Create a key at **App Store Connect → Users and Access → Integrations → App Store
Connect API** with the *Developer* role. Download the `AuthKey_XXXXXXXXXX.p8`
**once** (Apple won't let you re-download it) and store it somewhere safe, e.g.
`~/.appstoreconnect/private_keys/`.

Set three env vars:
```sh
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX          # the Key ID (10 chars)
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee   # Issuer ID (UUID)
```

### Fallback: Apple ID + app-specific password

The hook also accepts (used only if the API-key vars are absent):
```sh
export APPLE_ID='you@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'   # appleid.apple.com
export APPLE_TEAM_ID=XXXXXXXXXX
```

## Build

```sh
npm run dist        # arm64 + x64 DMGs → dist/
```

With signing + notarization active you'll see `notarize submitting …` then
`done in Ns — stapled ticket attached`. Confirm the result:
```sh
spctl -a -vvv -t install "dist/mac-arm64/Radical Browser.app"   # → accepted, source=Notarized Developer ID
xcrun stapler validate "dist/Radical Browser-0.3.12-arm64.dmg"
```

## Notes

- The same API-key credentials work for `notarytool`, `altool`, Xcode, and CI —
  reuse them across projects.
- Hardened runtime + entitlements live in `assets/entitlements.mac.plist`
  (JIT for Chromium, network client/server for casting, camera/mic for WebRTC).
- Occasionally electron-builder logs `unable to execute hdiutil detach … /Volumes/Radical Browser`
  during DMG cleanup — a macOS mount race, harmless; the `.dmg` is still written.
  If a build fails on it, run `hdiutil detach -force '/Volumes/Radical Browser'` and retry.
