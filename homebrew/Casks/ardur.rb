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

  depends_on :macos

  app "Ardur.app"
  # Electron resolves its helper apps from the path it was launched with, so a symlink straight to
  # Contents/MacOS/Ardur aborts with "Unable to find helper app". The wrapper keeps the bundle path.
  command_wrapper "ardur", executable: "#{appdir}/Ardur.app/Contents/MacOS/Ardur"

@MACOS_CAVEATS@
end
