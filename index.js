import express from "express";
import { Telegraf } from "telegraf";

// --- ENV (set these locally or on Render) ---
const BOT_TOKEN = process.env.BOT_TOKEN;               // Telegram bot token (from BotFather)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;     // e.g. whk_123abc
const TELEGRAM_SECRET = process.env.TELEGRAM_SECRET;   // any string you choose
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;         // your RapidAPI key (keep secret!)
const PORT = process.env.PORT || 10000;

// RapidAPI config
const RAPID_HOST = "youtube-mp36.p.rapidapi.com";      // fixed
// Endpoint: GET https://youtube-mp36.p.rapidapi.com/dl?id=<VIDEO_ID>

if (!BOT_TOKEN || !WEBHOOK_SECRET || !TELEGRAM_SECRET || !RAPIDAPI_KEY) {
  console.error("Need BOT_TOKEN, WEBHOOK_SECRET, TELEGRAM_SECRET, RAPIDAPI_KEY");
  process.exit(1);
}

const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

// --- Helpers ---
function extractYouTubeId(input) {
  if (!input) return null;
  try {
    const url = new URL(input.trim());

    // youtu.be/<id>
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace("/", "");
      return id || null;
    }

    // youtube.com/*
    if (url.hostname.endsWith("youtube.com")) {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }
      // /shorts/<id>  or /live/<id>
      const m = url.pathname.match(/^\/(shorts|live)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[2];
    }
  } catch { /* fall through to regex */ }

  // Fallback regex: try to find a 11-char video id
  const rx = /(?:v=|\/)([A-Za-z0-9_-]{11})(?:[?&/]|$)/;
  const m = input.match(rx);
  return m ? m[1] : null;
}

async function fetchMp3Meta(videoId) {
  const url = `https://${RAPID_HOST}/dl?id=${encodeURIComponent(videoId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": RAPID_HOST
    }
  });
  if (!res.ok) {
    throw new Error(`RapidAPI error ${res.status}`);
  }
  const data = await res.json(); // { link, title, filesize, progress, duration, status, msg }
  if (data.status !== "ok" || !data.link) {
    throw new Error(`Extractor not ready/failed: ${data?.status || "unknown"}`);
  }
  return data;
}

// --- Bot logic ---
bot.start((ctx) =>
  ctx.reply("Send me a YouTube link and I’ll reply with the MP3. 🙂")
);

bot.on("text", async (ctx) => {
  const text = ctx.message?.text || "";
  const id = extractYouTubeId(text);

  if (!id) {
    return ctx.reply("Please send a valid YouTube link (youtube.com or youtu.be).");
  }

  try { await ctx.sendChatAction("upload_audio"); } catch {}

  try {
    const meta = await fetchMp3Meta(id);
    // Optional: size guard (Telegram cloud limit ~50 MB)
    if (typeof meta.filesize === "number" && meta.filesize > 49 * 1024 * 1024) {
      return ctx.reply("File is too large for Telegram. Try a shorter video.");
    }

    await ctx.replyWithAudio(meta.link, {
      title: meta.title || "Audio",
      performer: "YouTube",
      duration: Math.round(Number(meta.duration || 0)) || undefined,
      caption: meta.title ? `🎵 ${meta.title}` : undefined
    });
  } catch (e) {
    console.error(e);
    await ctx.reply("Sorry, couldn’t get that MP3. Try another link or later.");
  }
});

// --- Webhook endpoint ---
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  // Verify Telegram secret header
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== TELEGRAM_SECRET) {
    return res.status(401).end();
  }
  res.status(200).end();
  setImmediate(() => bot.handleUpdate(req.body).catch(console.error));
});

// Health check
app.get("/healthz", (_, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  console.log(`Webhook path: /webhook/${WEBHOOK_SECRET}`);
});
