[phases.setup]
nixPkgs = ["chromium", "nodejs_20"]

[phases.install]
cmds = ["npm install"]

[phases.build]
cmds = []

[start]
cmd = "node index.js"

[variables]
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = "true"
PUPPETEER_EXECUTABLE_PATH = "/run/current-system/sw/bin/chromium"
