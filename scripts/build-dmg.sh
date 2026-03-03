#!/usr/bin/env bash
set -e

APP_NAME="Orbiv"
VERSION=$(node -p "require('./package.json').version")
OUT_DIR="out/make"
APP_PATH="out/${APP_NAME}-darwin-x64/${APP_NAME}.app"
DMG_PATH="${OUT_DIR}/${APP_NAME}-${VERSION}.dmg"

echo "▶ Running electron-forge package..."
npm run package

echo "▶ Creating DMG with hdiutil..."
mkdir -p "${OUT_DIR}"

# Create a temporary folder to stage the DMG contents
STAGING=$(mktemp -d)
cp -R "${APP_PATH}" "${STAGING}/"
ln -s /Applications "${STAGING}/Applications"

# Build the DMG
hdiutil create \
  -volname "${APP_NAME}" \
  -srcfolder "${STAGING}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

rm -rf "${STAGING}"

echo "✅ DMG created at ${DMG_PATH}"
echo ""
echo "To upload to GitHub Releases, run:"
echo "  gh release create v${VERSION} ${DMG_PATH} --title \"${APP_NAME} v${VERSION}\" --notes \"macOS release — drag ${APP_NAME}.app to Applications to install.\""
