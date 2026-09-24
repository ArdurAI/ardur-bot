# Release workflow replaces these placeholders using the actual DMG checksums.
cask "ardur-bot" do
  version "@VERSION@"
  on_arm do
    sha256 "@ARM64_SHA256@"
    url "https://github.com/ArdurAI/ardur-bot/releases/download/v#{version}/ardur-bot-#{version}-mac-arm64.dmg"
  end
  on_intel do
    sha256 "@X64_SHA256@"
    url "https://github.com/ArdurAI/ardur-bot/releases/download/v#{version}/ardur-bot-#{version}-mac-x64.dmg"
  end
  name "Ardur Bot"
  desc "Persistent bots on computers and models you choose"
  homepage "https://github.com/ArdurAI/ardur-bot"
  app "Ardur Bot.app"
  binary "#{appdir}/Ardur Bot.app/Contents/MacOS/Ardur Bot", target: "ardur-bot"
  caveats "Unsigned and not notarized. Approve the app in Privacy & Security. Signed builds come later."
end
