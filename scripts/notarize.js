// electron-builder afterSign hook — notarize the signed .app with Apple.
//
// Runs automatically after signing during `electron-builder`. It no-ops (build
// still succeeds, just un-notarized) when no credentials or no signing identity
// are present, so unsigned dev builds keep working untouched.
//
// Credentials, in order of preference:
//   1. App Store Connect API key (recommended, reusable across projects/CI):
//        APPLE_API_KEY        absolute path to the AuthKey_XXXXXXXXXX.p8 file
//        APPLE_API_KEY_ID     the key's Key ID (10 chars)
//        APPLE_API_ISSUER     the Issuer ID (UUID) from App Store Connect
//   2. Apple ID + app-specific password (fallback):
//        APPLE_ID             your Apple ID email
//        APPLE_APP_SPECIFIC_PASSWORD   an app-specific password (appleid.apple.com)
//        APPLE_TEAM_ID        your 10-char Team ID
//
// Signing itself is handled by electron-builder from a "Developer ID Application"
// cert in the keychain, or via CSC_LINK (path/base64 of a .p12) + CSC_KEY_PASSWORD.

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  const env = process.env
  const hasApiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
  const hasAppleId = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID

  if (!hasApiKey && !hasAppleId) {
    console.log('  • notarize        skipped — no Apple credentials in env (see scripts/notarize.js)')
    return
  }
  // Don't attempt notarization of an unsigned app — it can only fail.
  if (!env.CSC_LINK && !env.CSC_IDENTITY_AUTO_DISCOVERY && !hasSigningIdentity()) {
    console.log('  • notarize        skipped — app is not code-signed (no Developer ID identity)')
    return
  }

  const { notarize } = require('@electron/notarize')
  const opts = hasApiKey
    ? { appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER }
    : { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID }

  console.log(`  • notarize        submitting ${appName}.app via ${hasApiKey ? 'API key' : 'Apple ID'} (notarytool)…`)
  const t0 = Date.now()
  await notarize({ tool: 'notarytool', appPath, ...opts })
  console.log(`  • notarize        done in ${Math.round((Date.now() - t0) / 1000)}s — stapled ticket attached`)
}

function hasSigningIdentity() {
  try {
    const { execSync } = require('node:child_process')
    const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' })
    return /Developer ID Application/.test(out)
  } catch {
    return false
  }
}
