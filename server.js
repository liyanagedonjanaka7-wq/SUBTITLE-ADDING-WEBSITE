const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;

// Create directories
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
[uploadsDir, outputDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB max
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video') {
      const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.ts'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (videoExts.includes(ext)) return cb(null, true);
      return cb(new Error('Invalid video format. Supported: MP4, MKV, AVI, MOV, WebM, FLV, WMV, M4V, TS'));
    }
    if (file.fieldname === 'subtitle') {
      const subExts = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (subExts.includes(ext)) return cb(null, true);
      return cb(new Error('Invalid subtitle format. Supported: SRT, ASS, SSA, VTT, SUB'));
    }
    cb(new Error('Unexpected field'));
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Upload & mux endpoint
app.post('/api/upload', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'subtitle', maxCount: 1 }
]), (req, res) => {
  if (!req.files || !req.files.video || !req.files.subtitle) {
    // Cleanup any uploaded files
    if (req.files) {
      Object.values(req.files).flat().forEach(f => {
        fs.unlink(f.path, () => {});
      });
    }
    return res.status(400).json({ error: 'Both video and subtitle files are required.' });
  }

  const videoFile = req.files.video[0];
  const subtitleFile = req.files.subtitle[0];
  const jobId = uuidv4();
  
  // Get original video name without extension for the output filename
  const originalName = path.parse(videoFile.originalname).name;
  const outputFilename = `${originalName}_subtitled_${jobId.slice(0, 8)}.mkv`;
  const outputPath = path.join(outputDir, outputFilename);

  // Determine subtitle codec based on format
  const subExt = path.extname(subtitleFile.originalname).toLowerCase();
  let subtitleCodec = 'srt'; // default
  if (subExt === '.ass' || subExt === '.ssa') subtitleCodec = 'ass';
  else if (subExt === '.vtt') subtitleCodec = 'webvtt';
  else if (subExt === '.srt') subtitleCodec = 'srt';

  // Soft-mux: copy video+audio streams, add subtitle as separate track
  const command = ffmpeg()
    .input(videoFile.path)
    .input(subtitleFile.path)
    .outputOptions([
      '-c', 'copy',           // Copy all streams — no re-encoding
      '-map', '0',            // Map all streams from video
      '-map', '1',            // Map subtitle stream
      '-c:s', subtitleCodec,  // Subtitle codec
      '-metadata:s:s:0', `language=sin`,  // Mark as Sinhala
      '-metadata:s:s:0', `title=Sinhala Subtitles`
    ])
    .output(outputPath)
    .on('start', (cmdline) => {
      console.log(`[${jobId}] FFmpeg started: ${cmdline}`);
    })
    .on('end', () => {
      console.log(`[${jobId}] Muxing complete: ${outputFilename}`);
      
      // Cleanup uploaded files
      fs.unlink(videoFile.path, () => {});
      fs.unlink(subtitleFile.path, () => {});

      res.json({
        success: true,
        jobId,
        filename: outputFilename,
        downloadUrl: `/api/download/${jobId}/${encodeURIComponent(outputFilename)}`
      });
    })
    .on('error', (err) => {
      console.error(`[${jobId}] FFmpeg error:`, err.message);
      
      // Cleanup
      fs.unlink(videoFile.path, () => {});
      fs.unlink(subtitleFile.path, () => {});
      fs.unlink(outputPath, () => {});

      res.status(500).json({
        error: 'Failed to process video. Please check your files and try again.',
        details: err.message
      });
    });

  command.run();
});

// Download endpoint
app.get('/api/download/:jobId/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(outputDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found. It may have already been downloaded or expired.' });
  }

  const decodedFilename = decodeURIComponent(filename);
  
  res.download(filePath, decodedFilename, (err) => {
    if (err) {
      console.error('Download error:', err.message);
    }
    // Auto-cleanup after download
    setTimeout(() => {
      fs.unlink(filePath, () => {
        console.log(`Cleaned up: ${filename}`);
      });
    }, 60000); // Cleanup after 1 minute
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 5GB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`\n🎬 Subtitle Muxer running at http://localhost:${PORT}\n`);
});
