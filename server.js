const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Where downloaded/merged videos get cached and served from.
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR));

// Tracks in-progress downloads by video ID so two requests for the same
// video (e.g. a double-click, or a page refresh while it's still fetching)
// don't launch two overlapping yt-dlp processes writing to the same files.
const inFlight = new Map();

// Tracks the latest known progress per video ID (stage + percent) so the
// frontend can poll /api/progress while the /api/play request is still
// downloading/merging in the background.
const progress = new Map();

// yt-dlp prints lines like:
//   [download]  42.1% of  927.00MiB at   9.50MiB/s ETA 00:53
//   [Merger] Merging formats into "downloads/xyz.mp4"
// We scan its stdout/stderr as it streams in and turn those into a simple
// {stage, percent} we can hand back over HTTP.
function parseProgressLine(line, videoId) {
  const downloadMatch = line.match(/\[download\]\s+([\d.]+)%/);
  if (downloadMatch) {
    progress.set(videoId, { stage: "downloading", percent: parseFloat(downloadMatch[1]) });
    return;
  }
  if (line.includes("[Merger]") || line.includes("[ffmpeg]")) {
    progress.set(videoId, { stage: "merging", percent: 100 });
  }
}

// Keeps only the video currently being played on disk - wipes every other
// cached .mp4 so storage never grows past one video's worth.
function deleteOtherDownloads(keepVideoId) {
  for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
    if (file !== `${keepVideoId}.mp4`) {
      fs.unlinkSync(path.join(DOWNLOAD_DIR, file));
    }
  }
}

// Pulls the 11-char YouTube video ID out of the common URL shapes
// (watch?v=, youtu.be/, shorts/). Also strips things like &t=2244s since
// we only need the ID for our own file naming - yt-dlp still gets the
// full original URL.
function extractVideoId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/
  );
  return match ? match[1] : null;
}

app.get("/api/play", (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' query param" });
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: "Could not find a YouTube video ID in that URL" });
  }

  const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

  // Already fetched this one before - skip yt-dlp entirely.
  if (fs.existsSync(outputPath)) {
    progress.set(videoId, { stage: "done", percent: 100 });
    return res.json({ streamUrl: `/downloads/${videoId}.mp4`, videoId });
  }

  // Most YouTube videos no longer expose a single "progressive" stream that
  // already has video+audio combined - anything above ~360p is split into
  // separate video-only and audio-only DASH tracks. A plain "-g" (print
  // direct URL) can only ever hand back ONE url, so it fails whenever no
  // combined stream exists (which is now the common case).
  //
  // So instead we let yt-dlp DOWNLOAD the best video track and the best
  // audio track and MUX them together locally with ffmpeg into one mp4
  // file. We then serve that single local file to the <video> tag - this
  // works for every video, regardless of whether YouTube has a combined
  // stream available.
  //
  // -f "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b":
  //   bestvideo (H.264/avc1, mp4) + bestaudio (m4a), muxed together - no
  //   height cap, so this grabs the highest resolution YouTube offers in
  //   H.264 (usually 1080p). We pin to avc1 specifically (rather than any
  //   mp4 video track) because YouTube's highest-res mp4 tracks are often
  //   AV1-encoded, and AV1-in-MP4 is muxed less reliably by ffmpeg and has
  //   spottier <video> tag support than plain H.264. Falls back to any
  //   combined/progressive format if that pairing isn't available.
  // --merge-output-format mp4: tell yt-dlp/ffmpeg to mux the pair into mp4.
  // -o: where to write the resulting file.
  const args = [
    "-f", "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format", "mp4",
    "-o", outputPath,
    url,
  ];

  // If a download for this video is already running, piggyback on it
  // instead of starting a second yt-dlp process.
  let downloadPromise = inFlight.get(videoId);
  if (!downloadPromise) {
    progress.set(videoId, { stage: "starting", percent: 0 });
    deleteOtherDownloads(videoId);

    downloadPromise = new Promise((resolve, reject) => {
      // spawn (rather than execFile) gives us the output as it streams in,
      // instead of all at once when the process exits - that's what lets
      // us report live progress.
      const proc = spawn("yt-dlp", args, { timeout: 20 * 60 * 1000 });

      let stderrBuf = "";
      let lineBuf = "";
      const onData = (chunk) => {
        lineBuf += chunk.toString();
        // yt-dlp rewrites its progress line with \r; split on \r or \n
        // so we see each update as its own line.
        const lines = lineBuf.split(/\r|\n/);
        lineBuf = lines.pop(); // last (possibly incomplete) line
        for (const line of lines) parseProgressLine(line, videoId);
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
        onData(chunk);
      });

      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderrBuf || `yt-dlp exited with code ${code}`));
        resolve();
      });
    }).finally(() => inFlight.delete(videoId));
    inFlight.set(videoId, downloadPromise);
  }

  downloadPromise
    .then(() => {
      progress.set(videoId, { stage: "done", percent: 100 });
      res.json({ streamUrl: `/downloads/${videoId}.mp4`, videoId });
    })
    .catch((err) => {
      console.error("yt-dlp error:", err.message);
      progress.set(videoId, { stage: "error", percent: 0 });
      res.status(500).json({
        error: "yt-dlp failed to download/extract this video. Is yt-dlp (and ffmpeg) installed?",
        details: err.message,
      });
    });
});

// Lets the frontend poll "how far along is this video?" while the
// /api/play request for it is still in flight.
app.get("/api/progress", (req, res) => {
  const { videoId } = req.query;
  res.json(progress.get(videoId) || { stage: "idle", percent: 0 });
});

app.listen(PORT, () => {
  console.log(`youtube-play-proxy listening on http://localhost:${PORT}`);
});
