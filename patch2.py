import re

with open("scripts/desktop-release-assets.mjs", "r") as f:
    content = f.read()

content = content.replace('import crypto from "node:crypto";', 'const crypto = await import("node:crypto");')

with open("scripts/desktop-release-assets.mjs", "w") as f:
    f.write(content)
