const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// YouTube's bot-detection often blocks yt-dlp outright ("Sign in to confirm
// you're not a bot"), especially from cloud/datacenter IPs like Railway's.
// Passing cookies from a real logged-in browser session makes requests look
// like an actual signed-in user, which avoids most of that blocking.
//
// cookies.txt is bundled directly into the deployed image/repo (no env var)
// - exported from a browser and committed alongside the code.
const cookiesPath = path.join(__dirname, "cookies.txt");
const hasCookies = fs.existsSync(cookiesPath);
console.log(hasCookies ? "yt-dlp: using cookies from " + cookiesPath : "yt-dlp: no cookies configured");

// Where downloaded/merged videos get cached and served from. Each viewer
// gets their own subfolder (see getSessionId below) so one person's video
// can't be deleted out from under another person playing something else
// at the same time.
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR));

// Tracks the currently running/queued download CHAIN per sessionId (not per
// video). Every /api/play for the same viewer - whether it's the same video
// again or a different one from a duplicate tab - gets appended to this
// chain, so downloads for one viewer always run one at a time. Without this,
// a second video request arriving while the first is still downloading
// would run deleteOtherDownloads() concurrently and rip the first
// download's in-progress temp files out from under it.
const inFlight = new Map();

// Tracks the latest known progress per "sessionId:videoId" (stage + percent)
// so the frontend can poll /api/progress while the /api/play request is
// still downloading/merging in the background.
const progress = new Map();

// Identifies which viewer is making the request via a random cookie, so
// each browser gets its own isolated download folder. Without this, "delete
// the old video when a new one starts" would delete other viewers' videos
// too whenever multiple people use the deployed app at once.
function getSessionId(req, res) {
  const existing = (req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("sid="));
  if (existing) return existing.slice(4);

  const sid = crypto.randomUUID();
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

// yt-dlp prints lines like:
//   [download]  42.1% of  927.00MiB at   9.50MiB/s ETA 00:53
//   [Merger] Merging formats into "downloads/xyz.mp4"
// We scan its stdout/stderr as it streams in and turn those into a simple
// {stage, percent} we can hand back over HTTP.
function parseProgressLine(line, key) {
  const downloadMatch = line.match(/\[download\]\s+([\d.]+)%/);
  if (downloadMatch) {
    progress.set(key, { stage: "downloading", percent: parseFloat(downloadMatch[1]) });
    return;
  }
  if (line.includes("[Merger]") || line.includes("[ffmpeg]")) {
    progress.set(key, { stage: "merging", percent: 100 });
  }
}

// Keeps only the video currently being played for THIS viewer on disk -
// wipes every other cached .mp4 in their own session folder so storage
// never grows past one video's worth per viewer.
function deleteOtherDownloads(sessionDir, keepVideoId) {
  for (const file of fs.readdirSync(sessionDir)) {
    if (file !== `${keepVideoId}.mp4`) {
      fs.unlinkSync(path.join(sessionDir, file));
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

  const sessionId = getSessionId(req, res);
  const sessionDir = path.join(DOWNLOAD_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const key = `${sessionId}:${videoId}`;
  const outputPath = path.join(sessionDir, `${videoId}.mp4`);
  const streamUrl = `/downloads/${sessionId}/${videoId}.mp4`;

  // Already fetched this one before - skip yt-dlp entirely.
  if (fs.existsSync(outputPath)) {
    progress.set(key, { stage: "done", percent: 100 });
    return res.json({ streamUrl, videoId });
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
  // --cookies: only added when cookies.txt exists - makes yt-dlp look like
  // a signed-in browser to dodge YouTube's bot-detection block.
  const args = [
    ...(hasCookies ? ["--cookies", cookiesPath] : []),
    "-f", "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format", "mp4",
    "-o", outputPath,
    url,
  ];

  // Chain this download after whatever's currently running/queued for this
  // SESSION (regardless of which video that was) - guarantees the cleanup
  // step below never runs while a previous download is still writing files.
  const previous = inFlight.get(sessionId) || Promise.resolve();

  const downloadPromise = previous.catch(() => {}).then(() => {
    // Someone else already finished downloading this exact video while we
    // were waiting our turn in the queue - nothing left to do.
    if (fs.existsSync(outputPath)) return;

    progress.set(key, { stage: "starting", percent: 0 });
    deleteOtherDownloads(sessionDir, videoId);

    return new Promise((resolve, reject) => {
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
        for (const line of lines) parseProgressLine(line, key);
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
    });
  });
  inFlight.set(sessionId, downloadPromise);

  downloadPromise
    .then(() => {
      progress.set(key, { stage: "done", percent: 100 });
      res.json({ streamUrl, videoId });
    })
    .catch((err) => {
      console.error("yt-dlp error:", err.message);
      progress.set(key, { stage: "error", percent: 0 });
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
  const sessionId = getSessionId(req, res);
  res.json(progress.get(`${sessionId}:${videoId}`) || { stage: "idle", percent: 0 });
});

app.listen(PORT, () => {
  console.log(`youtube-play-proxy listening on http://localhost:${PORT}`);
});
