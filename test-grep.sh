curl -sL https://api.github.com/repos/ArdurAI/ardur-bot/releases | grep -m 1 '"tag_name":' | cut -d '"' -f 4
