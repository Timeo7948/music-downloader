const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const YTDLP  = 'C:/Users/timeo/AppData/Local/Microsoft/WinGet/Links/yt-dlp.exe';
const FFMPEG = 'C:/Users/timeo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';

const URL = process.argv[2];
if (!URL) {
  console.error('Usage: node script.js <url>');
  process.exit(1);
}

const OUTPUT_DIR = './downloads/music';
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// Étape 1 : récupérer les infos de la playlist / vidéo
console.log('Récupération des informations...');

const infoProc = spawn(YTDLP, [
  '--flat-playlist',
  '--dump-single-json',
  '--no-warnings',
  URL
]);

let infoData = '';
infoProc.stdout.on('data', d => infoData += d.toString());
infoProc.stderr.on('data', d => console.log('[yt-dlp info]', d.toString().trim()));

infoProc.on('close', () => {
  let entries = [];

  try {
    const info = JSON.parse(infoData);

    if (info.entries) {
      // Playlist
      entries = info.entries.map(e => ({
        id: e.id,
        title: e.title || e.id,
        url: `https://www.youtube.com/watch?v=${e.id}`
      }));
      console.log(`Playlist détectée : ${info.title} — ${entries.length} piste(s)`);
    } else {
      // Vidéo seule
      entries = [{ id: info.id, title: info.title || info.id, url: URL }];
      console.log(`Vidéo seule : ${info.title}`);
    }
  } catch (e) {
    console.error('Erreur parsing JSON :', e.message);
    process.exit(1);
  }

  // Étape 2 : télécharger chaque piste séquentiellement
  downloadNext(entries, 0);
});

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function downloadNext(entries, index) {
  if (index >= entries.length) {
    console.log('\nTous les téléchargements sont terminés !');
    return;
  }

  const { title, url } = entries[index];
  const safeTitle = sanitizeFilename(title);
  const outputPath = path.join(OUTPUT_DIR, `${safeTitle}.mp3`);

  console.log(`\n[${index + 1}/${entries.length}] Téléchargement : ${title}`);

  const ytDlp = spawn(YTDLP, [
    '-f', 'bestaudio',
    '-o', '-',
    '--no-warnings',
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const ffmpeg = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-q:a', '2',          // qualité VBR haute (~190 kbps)
    '-f', 'mp3',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ytDlp.stdout.pipe(ffmpeg.stdin);
  ytDlp.stderr.on('data', d => console.log('[yt-dlp]', d.toString().trim()));
  ffmpeg.stderr.on('data', d => console.log('[ffmpeg]', d.toString().trim()));

  const out = fs.createWriteStream(outputPath);
  ffmpeg.stdout.pipe(out);

  let bytes = 0;
  ffmpeg.stdout.on('data', d => {
    bytes += d.length;
    process.stdout.write(`\r  Reçu : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  });

  out.on('finish', () => {
    console.log(`\n  Fichier créé : ${outputPath}`);
  });

  ytDlp.on('close', code => {
    if (code !== 0) console.log(`[yt-dlp] terminé avec code ${code}`);
    ffmpeg.stdin.end();
  });

  ffmpeg.on('close', code => {
    if (code !== 0) console.log(`[ffmpeg] terminé avec code ${code}`);
    // Piste suivante une fois ffmpeg terminé
    downloadNext(entries, index + 1);
  });
}