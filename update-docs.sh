#!/bin/bash
sed -i '' 's/installation on a paired macOS or Linux host. Windows is unavailable until its/installation on a paired macOS or Linux host, or running Ardur natively on this computer in local mode or the dev stack. Windows is unavailable until its/' docs/runtimes/hermes.md
sed -i '' 's/account. A missing install, unsupported connection, non-host computer or old host/account. A missing install, unsupported connection, non-host computer (unless running locally) or old host/' docs/runtimes/hermes.md
