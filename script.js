const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const YTDLP  = 'C:/Users/timeo/AppData/Local/Microsoft/WinGet/Links/yt-dlp.exe';
const FFMPEG = 'C:/Users/timeo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';

const URL = process.argv[2];
if (!URL) {
  console.error('Usage: node script.js <url>');
  process.exit(1);
}

const OUTPUT_DIR = './downloads';
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Convertit la pochette en JPEG propre via ffmpeg (carré, 500x500)
function convertCover(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vf', 'scale=500:500:force_original_aspect_ratio=decrease,pad=500:500:(ow-iw)/2:(oh-ih)/2:black',
      '-c:v', 'mjpeg',
      '-q:v', '2',
      outputPath
    ]);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg cover code ${code}`)));
  });
}

// ─── Récupération playlist / vidéo ──────────────────────────────────────────

console.log('Récupération des informations...');

const infoProc = spawn(YTDLP, [
  '--flat-playlist',
  '--dump-single-json',
  '--no-warnings',
  URL
]);

let infoData = '';
infoProc.stdout.on('data', d => infoData += d.toString());
infoProc.stderr.on('data', d => process.stderr.write('[yt-dlp info] ' + d));

infoProc.on('close', () => {
  let entries = [];
  try {
    const info = JSON.parse(infoData);
    if (info.entries) {
      entries = info.entries.map(e => ({
        id: e.id,
        url: `https://www.youtube.com/watch?v=${e.id}`
      }));
      console.log(`Playlist : "${info.title}" — ${entries.length} piste(s)\n`);
    } else {
      entries = [{ id: info.id, url: URL }];
    }
  } catch (e) {
    console.error('Erreur parsing JSON :', e.message);
    process.exit(1);
  }
  downloadNext(entries, 0);
});

// ─── Téléchargement séquentiel ───────────────────────────────────────────────

async function downloadNext(entries, index) {
  if (index >= entries.length) {
    console.log('\n✅ Tous les téléchargements sont terminés !');
    return;
  }

  const entry = entries[index];
  console.log(`\n[${index + 1}/${entries.length}] Récupération des métadonnées...`);

  // ── Métadonnées complètes ────────────────────────────────────────────────
  let meta;
  try {
    const raw = execFileSync(YTDLP, [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      entry.url
    ]).toString();
    meta = JSON.parse(raw);
  } catch (e) {
    console.error('  Erreur métadonnées :', e.message);
    downloadNext(entries, index + 1);
    return;
  }

  const title   = meta.title      || 'Unknown Title';
  const artist  = meta.artist     || meta.uploader || meta.channel || 'Unknown Artist';
  const album   = meta.album      || meta.playlist || '';
  const year    = (meta.upload_date || '').slice(0, 4);
  const track   = meta.playlist_index ? String(meta.playlist_index) : '';
  const genre   = meta.genre      || '';

  // Choisir la meilleure miniature (préférer ≥ 500px)
  let thumbUrl = '';
  if (meta.thumbnails?.length) {
    const sorted = [...meta.thumbnails]
      .filter(t => t.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    // Préférer une vignette carrée ou proche
    const square = sorted.find(t => t.width && t.height && Math.abs(t.width - t.height) < 100);
    thumbUrl = (square || sorted[0]).url;
  } else if (meta.thumbnail) {
    thumbUrl = meta.thumbnail;
  }

  const safeTitle    = sanitizeFilename(title);
  const outputPath   = path.join(OUTPUT_DIR, `${safeTitle}.mp3`);
  const thumbRaw     = path.join(OUTPUT_DIR, `_raw_${safeTitle}.jpg`);
  const thumbClean   = path.join(OUTPUT_DIR, `_cover_${safeTitle}.jpg`);

  console.log(`  Titre   : ${title}`);
  console.log(`  Artiste : ${artist}`);
  if (album) console.log(`  Album   : ${album}`);
  if (year)  console.log(`  Année   : ${year}`);
  if (genre) console.log(`  Genre   : ${genre}`);

  // ── Télécharger et convertir la pochette ─────────────────────────────────
  let hasCover = false;
  if (thumbUrl) {
    try {
      await downloadFile(thumbUrl, thumbRaw);
      await convertCover(thumbRaw, thumbClean);
      fs.unlinkSync(thumbRaw);
      hasCover = true;
      console.log('  Pochette : ✔');
    } catch (e) {
      console.log('  Pochette : échec —', e.message);
      [thumbRaw, thumbClean].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    }
  }

  // ── Arguments ffmpeg ─────────────────────────────────────────────────────
  //
  // On écrit d'abord le MP3 sans pochette, puis on réencapsule avec
  // id3v2 via un second pass ffmpeg pour que Navidrome lise bien l'image.
  //
  const tmpMp3 = outputPath + '.tmp.mp3';

  const pass1Args = [
    '-hide_banner', '-loglevel', 'error',
    '-y',
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libmp3lame', '-q:a', '2',
    '-id3v2_version', '3',          // ID3v2.3 — compatibilité max
    '-write_id3v1', '1',
    '-metadata', `title=${title}`,
    '-metadata', `artist=${artist}`,
    '-metadata', `album_artist=${artist}`,
  ];

  if (album) pass1Args.push('-metadata', `album=${album}`);
  if (year)  pass1Args.push('-metadata', `date=${year}`);
  if (track) pass1Args.push('-metadata', `track=${track}`);
  if (genre) pass1Args.push('-metadata', `genre=${genre}`);

  // Pas de comment — Navidrome peut mal parser certains champs libres
  pass1Args.push('-f', 'mp3', tmpMp3);

  // ── Pass 1 : audio + tags texte ──────────────────────────────────────────
  console.log('  Téléchargement audio...');

  const ytDlp = spawn(YTDLP, [
    '-f', 'bestaudio',
    '-o', '-',
    '--no-warnings',
    entry.url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const ffmpeg1 = spawn(FFMPEG, pass1Args, { stdio: ['pipe', 'pipe', 'pipe'] });

  ytDlp.stdout.pipe(ffmpeg1.stdin);
  ytDlp.stderr.on('data', d => process.stderr.write('[yt-dlp] ' + d));
  ffmpeg1.stderr.on('data', d => process.stderr.write('[ffmpeg1] ' + d));
  ffmpeg1.stdout.resume();

  let bytes = 0;
  ytDlp.stdout.on('data', d => {
    bytes += d.length;
    process.stdout.write(`\r  Audio reçu : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  });

  ytDlp.on('close', code => {
    if (code !== 0) console.log(`\n  [yt-dlp] code ${code}`);
    ffmpeg1.stdin.end();
  });

  ffmpeg1.on('close', async code => {
    if (code !== 0) {
      console.log(`\n  ❌ Pass 1 échoué (code ${code})`);
      [tmpMp3, thumbClean].forEach(f => { try { fs.unlinkSync(f); } catch {} });
      downloadNext(entries, index + 1);
      return;
    }

    // ── Pass 2 : intégrer la pochette proprement ──────────────────────────
    if (hasCover) {
      console.log('\n  Intégration de la pochette...');
      await new Promise((resolve) => {
        const pass2 = spawn(FFMPEG, [
          '-hide_banner', '-loglevel', 'error',
          '-y',
          '-i', tmpMp3,
          '-i', thumbClean,
          '-map', '0',
          '-map', '1',
          '-c', 'copy',
          '-id3v2_version', '3',
          '-metadata:s:v', 'title=Album cover',
          '-metadata:s:v', 'comment=Cover (front)',
          outputPath
        ]);
        pass2.stderr.on('data', d => process.stderr.write('[ffmpeg2] ' + d));
        pass2.on('close', resolve);
      });
      try { fs.unlinkSync(tmpMp3); } catch {}
      try { fs.unlinkSync(thumbClean); } catch {}
    } else {
      // Pas de pochette : renommer le tmp en final
      fs.renameSync(tmpMp3, outputPath);
    }

    console.log(`  ✅ Fichier créé : ${outputPath}`);
    downloadNext(entries, index + 1);
  });
}
