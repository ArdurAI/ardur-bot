# Release workflow replaces these placeholders using the actual DMG checksums.
cask "ardur" do
  version "@VERSION@"
  on_arm do
    sha256 "@ARM64_SHA256@"
    url "https://github.com/ArdurAI/ardur-bot/releases/download/v#{version}/ardur-#{version}-mac-arm64.dmg"
  end
  on_intel do
    sha256 "@X64_SHA256@"
    url "https://github.com/ArdurAI/ardur-bot/releases/download/v#{version}/ardur-#{version}-mac-x64.dmg"
  end
  name "Ardur"
  desc "Persistent bots on computers and models you choose"
  homepage "https://github.com/ArdurAI/ardur-bot"
  app "Ardur.app"
  binary "#{appdir}/Ardur.app/Contents/MacOS/Ardur", target: "ardur"
  caveats "Unsigned and not notarized. Approve the app in Privacy & Security. Signed builds come later."
end
