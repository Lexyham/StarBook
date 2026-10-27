/**
 * StarBook Celebrity Image Fetcher
 * Automatically fetches and caches real celebrity images
 * Sources: Wikipedia → TMDB → Fal.ai → Replicate → HuggingFace
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DB_PATH = path.join(__dirname, '../db/database.json');
const IMG_DIR = path.join(__dirname, '../public/images/celebrities');

// Ensure image directory exists
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

// API Keys from environment
const FAL_API_KEY = process.env.FAL_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const HUGGING_FACE_API_KEY = process.env.HUGGING_FACE_API_KEY || '';
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || '';

// ── HTTP helper ──────────────────────────────────────────
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const timeout = opts.timeout || 15000;
    const options = { headers: { 'User-Agent': 'StarBook/2.0 CelebImageFetcher', ...opts.headers } };

    const req = mod.get(url, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, opts).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchJson(url, opts = {}) {
  const res = await fetchUrl(url, opts);
  return JSON.parse(res.body.toString());
}

async function downloadImage(url, filepath, headers = {}) {
  const res = await fetchUrl(url, { headers });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers['content-type'] || '';
  if (!ct.startsWith('image/')) throw new Error(`Not an image: ${ct}`);
  fs.writeFileSync(filepath, res.body);
  return filepath;
}

// ── Source 1: Wikipedia REST API ─────────────────────────
async function fetchFromWikipedia(name) {
  const slug = name.replace(/ /g, '_');
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`;
  const data = await fetchJson(url);
  const imgUrl = data.originalimage?.source || data.thumbnail?.source;
  if (!imgUrl) throw new Error('No Wikipedia image');
  // Filter out generic images
  const lower = imgUrl.toLowerCase();
  if (lower.includes('flag') || lower.includes('map') || lower.includes('logo') || lower.includes('icon')) {
    throw new Error('Non-person image');
  }
  return imgUrl;
}

// ── Source 2: TMDB (Movies/TV) ───────────────────────────
async function fetchFromTMDB(name) {
  if (!TMDB_API_KEY) throw new Error('No TMDB key');
  const searchUrl = `https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}&include_adult=false`;
  const data = await fetchJson(searchUrl);
  const person = data.results?.[0];
  if (!person?.profile_path) throw new Error('No TMDB result');
  return `https://image.tmdb.org/t/p/w500${person.profile_path}`;
}

// ── Source 3: Fal.ai Image Generation ───────────────────
async function generateWithFal(name) {
  if (!FAL_API_KEY) throw new Error('No Fal.ai key');
  const prompt = buildImagePrompt(name);
  const response = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      image_size: { width: 512, height: 512 },
      num_inference_steps: 28,
      guidance_scale: 7.5,
      num_images: 1
    });
    const opts = {
      hostname: 'fal.run',
      path: '/fal-ai/flux/schnell',
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Fal timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  const imgUrl = response.body?.images?.[0]?.url;
  if (!imgUrl) throw new Error('No Fal.ai image URL');
  return imgUrl;
}

// ── Source 4: Replicate ──────────────────────────────────
async function generateWithReplicate(name) {
  if (!REPLICATE_API_KEY) throw new Error('No Replicate key');
  const prompt = buildImagePrompt(name);
  // Start prediction
  const body = JSON.stringify({
    version: 'ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4',
    input: { prompt, width: 512, height: 512, num_inference_steps: 28 }
  });
  const startOpts = {
    hostname: 'api.replicate.com',
    path: '/v1/predictions',
    method: 'POST',
    headers: {
      'Authorization': `Token ${REPLICATE_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  const startRes = await new Promise((resolve, reject) => {
    const req = https.request(startOpts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (!startRes.id) throw new Error('Replicate: no prediction ID');
  const pollUrl = `https://api.replicate.com/v1/predictions/${startRes.id}`;
  const headers = { 'Authorization': `Token ${REPLICATE_API_KEY}` };

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await fetchJson(pollUrl, { headers });
    if (poll.status === 'succeeded' && poll.output?.[0]) return poll.output[0];
    if (poll.status === 'failed') throw new Error('Replicate failed');
  }
  throw new Error('Replicate timeout');
}

// ── Source 5: HuggingFace ────────────────────────────────
async function generateWithHuggingFace(name) {
  if (!HUGGING_FACE_API_KEY) throw new Error('No HuggingFace key');
  const prompt = buildImagePrompt(name);
  const body = JSON.stringify({ inputs: prompt });
  const hfRes = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api-inference.huggingface.co',
      path: '/models/stabilityai/stable-diffusion-xl-base-1.0',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HUGGING_FACE_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ct: res.headers['content-type'] || '' }));
    });
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('HF timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (!hfRes.ct.startsWith('image/')) throw new Error('HuggingFace: not an image response');
  return hfRes.body; // raw binary
}

// ── Image prompt builder ─────────────────────────────────
function buildImagePrompt(name) {
  return `RAW photo, photorealistic professional portrait photography. Ultra realistic high-resolution photograph of ${name}. Maintain exact facial likeness and accurate facial structure with natural skin texture and realistic facial details. Clear visible face looking directly at the camera with a natural confident pose. Half-body portrait framing showing head and upper torso. Highly detailed eyes and natural expression. Cinematic soft studio lighting with realistic shadows. Professional DSLR camera quality using an 85mm portrait lens with shallow depth of field. Sharp focus with high dynamic range. Ultra detailed 8k resolution with natural colors. Professional photography style. NEGATIVE: blurry images, distorted faces, duplicate faces, extra fingers or limbs, bad anatomy, cartoon style, anime style, painting style, CGI look, unrealistic skin texture, cropped face, overexposed lighting, underexposed lighting`;
}

// ── Local path for a celebrity ───────────────────────────
function localPath(id, name) {
  const safe = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return path.join(IMG_DIR, `${id}_${safe}.png`);
}

function localUrl(id, name) {
  const safe = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `/images/celebrities/${id}_${safe}.png`;
}

// ── Main fetch for one celebrity ─────────────────────────
async function fetchImageForCeleb(celeb) {
  const lp = localPath(celeb.id, celeb.name);

  // Already cached locally - skip
  if (fs.existsSync(lp)) {
    return localUrl(celeb.id, celeb.name);
  }

  // Already has a real non-avatar image URL (from Wikipedia etc.) - download & cache it
  const currentImg = celeb.image || '';
  const isAvatar = currentImg.includes('ui-avatars') || currentImg.includes('pravatar') || !currentImg;

  // Try sources in order
  const sources = [
    async () => {
      if (!isAvatar) {
        // Download the existing real URL
        await downloadImage(currentImg, lp);
        return localUrl(celeb.id, celeb.name);
      }
      // Try Wikipedia
      const wikiUrl = await fetchFromWikipedia(celeb.name);
      await downloadImage(wikiUrl, lp);
      return localUrl(celeb.id, celeb.name);
    },
    async () => {
      const tmdbUrl = await fetchFromTMDB(celeb.name);
      await downloadImage(tmdbUrl, lp);
      return localUrl(celeb.id, celeb.name);
    },
    async () => {
      const falUrl = await generateWithFal(celeb.name);
      await downloadImage(falUrl, lp);
      return localUrl(celeb.id, celeb.name);
    },
    async () => {
      const repUrl = await generateWithReplicate(celeb.name);
      await downloadImage(repUrl, lp);
      return localUrl(celeb.id, celeb.name);
    },
    async () => {
      const hfBinary = await generateWithHuggingFace(celeb.name);
      fs.writeFileSync(lp, hfBinary);
      return localUrl(celeb.id, celeb.name);
    }
  ];

  for (const source of sources) {
    try {
      const result = await source();
      console.log(`  ✅ ${celeb.name}`);
      return result;
    } catch (e) {
      // Try next source
    }
  }

  // All sources failed - keep current URL (better than nothing)
  console.log(`  ⚠ ${celeb.name}: all sources failed, keeping original`);
  return celeb.image;
}

// ── Run all celebrities ──────────────────────────────────
async function fetchAllImages(batchSize = 5, delayMs = 500) {
  const db = JSON.parse(fs.readFileSync(DB_PATH));
  const celebs = db.celebrities;
  let updated = 0;

  console.log(`\n🖼  Fetching images for ${celebs.length} celebrities...\n`);

  for (let i = 0; i < celebs.length; i += batchSize) {
    const batch = celebs.slice(i, i + batchSize);
    await Promise.all(batch.map(async (celeb) => {
      const lp = localPath(celeb.id, celeb.name);
      // Skip if already local
      if (fs.existsSync(lp)) {
        if (!celeb.image.startsWith('/images/')) {
          celeb.image = localUrl(celeb.id, celeb.name);
          updated++;
        }
        return;
      }
      const newUrl = await fetchImageForCeleb(celeb);
      if (newUrl !== celeb.image) {
        celeb.image = newUrl;
        updated++;
      }
    }));

    // Save progress after each batch
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    if (delayMs > 0 && i + batchSize < celebs.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`\n✅ Image fetch complete. Updated: ${updated}/${celebs.length}`);
  return updated;
}

// ── Single celebrity fetch (for on-demand use) ───────────
async function fetchSingleImage(celebId) {
  const db = JSON.parse(fs.readFileSync(DB_PATH));
  const celeb = db.celebrities.find(c => c.id === celebId);
  if (!celeb) return null;
  const newUrl = await fetchImageForCeleb(celeb);
  celeb.image = newUrl;
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  return newUrl;
}

module.exports = { fetchAllImages, fetchSingleImage, localUrl, localPath };

// Run directly: node server/image-fetcher.js
if (require.main === module) {
  fetchAllImages().catch(console.error);
}
