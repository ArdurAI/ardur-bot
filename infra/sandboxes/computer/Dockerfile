FROM debian:bookworm-slim AS capture-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libx11-dev \
    libxdamage-dev \
    libxext-dev \
    libxfixes-dev \
    libxtst-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o libardurbot-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xterm \
    xdotool \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    ca-certificates \
    procps \
    bash \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    dbus-x11 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 ardurbot \
  && useradd --uid 1000 --gid ardurbot --create-home --shell /bin/bash ardurbot \
  && mkdir -p /etc/ardurbot/fluxbox \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
ENV DISPLAY=:1
ENV HOME=/home/ardurbot
WORKDIR /home/ardurbot
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/ardurbot-computer
COPY --chmod=755 control.py /usr/local/bin/ardurbot-computer-control
COPY --from=capture-builder /build/libardurbot-xcapture.so /usr/local/lib/libardurbot-xcapture.so
COPY --chmod=755 ardurbot-browser /usr/local/bin/ardurbot-browser
COPY --chmod=755 ardurbot-page-browser /usr/local/bin/ardurbot-page-browser
COPY --chmod=644 ardurbot-browser.desktop /usr/share/applications/ardurbot-browser.desktop
COPY --chmod=644 fluxbox.init /etc/ardurbot/fluxbox/init
COPY --chmod=644 fluxbox.apps /etc/ardurbot/fluxbox/apps
COPY --chmod=644 fluxbox.menu /etc/ardurbot/fluxbox/menu
COPY --chmod=644 embed.html /usr/share/novnc/embed.html
COPY --chmod=644 clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
COPY --chmod=644 mobile-keyboard.js /usr/share/novnc/mobile-keyboard.js
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/ardurbot-computer /usr/local/bin/ardurbot-computer-control /usr/local/bin/ardurbot-browser /usr/local/bin/ardurbot-page-browser \
    /etc/ardurbot/fluxbox/init /etc/ardurbot/fluxbox/apps /etc/ardurbot/fluxbox/menu
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
USER 1000:1000
CMD ["/usr/local/bin/ardurbot-computer"]
