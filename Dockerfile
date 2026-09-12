FROM node:20-bookworm-slim

# ffmpeg: muxes yt-dlp's separate video+audio tracks into one mp4.
# python3 + curl: needed to run/fetch the yt-dlp binary below.
# unzip: needed by the Deno install script below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp as a standalone binary (not via pip) - avoids Debian's
# "externally managed environment" restriction on system-wide pip installs.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# yt-dlp needs a JS runtime to solve YouTube's "n challenge" (a URL-signing
# puzzle) - without one, most video formats get skipped and only thumbnail
# images are extractable. yt-dlp specifically looks for Deno by default.
ENV DENO_INSTALL="/usr/local"
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
