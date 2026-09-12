FROM node:20-bookworm-slim

# ffmpeg: muxes yt-dlp's separate video+audio tracks into one mp4.
# python3 + curl: needed to run/fetch the yt-dlp binary below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp as a standalone binary (not via pip) - avoids Debian's
# "externally managed environment" restriction on system-wide pip installs.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
