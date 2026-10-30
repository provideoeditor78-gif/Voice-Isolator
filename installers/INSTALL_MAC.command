#!/bin/bash
cd "$(dirname "$0")"
echo "Pehle After Effects aur Premiere Pro band kar dein."; read -p "Enter dabayein..."
for v in 9 10 11 12; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.yourname.voicesep"
rm -rf "$DEST"; mkdir -p "$DEST"; cp -R panel/. "$DEST/"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
echo
echo "INSTALL COMPLETE. After Effects / Premiere kholein: Window > Extensions > Voice Separator"
echo "Pehli dafa 'Download essential files' button dabayein."
