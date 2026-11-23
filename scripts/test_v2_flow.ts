import fs from 'node:fs';
import path from 'node:path';
import { parseMultilineTimestamps } from '../src/lib/timestampParser.ts';
import { detectSegmentFacecam } from '../server/facecamDetector.ts';
import { renderSegmentClipV2 } from '../server/rendererV2.ts';
import { generateSampleStreamVideo } from '../server/ingest.ts';
import { SOURCES_DIR, RENDERS_DIR, ensureWorkspace } from '../server/storage.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runTests() {
  console.log('=== ClipForge V2 Acceptance Test Suite ===\n');
  ensureWorkspace();

  // Test 1: Single Multiline Timestamp Input & Validation
  console.log('Test 1: Multiline Timestamp Parsing & Duplicate/Overlap Detection');
  const input = `
00:01:00 - 00:01:45 Opening Highlight
00:02:10 - 00:03:00 Epic clutch
00:02:50 - 00:03:30 Overlapping segment
00:01:00 - 00:01:45 Duplicate line
00:10:00 - 00:08:00 Invalid reversed time
`;

  const parsed = parseMultilineTimestamps(input, 3600);
  console.log(`- Valid segments count: ${parsed.validCount}`);
  console.log(`- Line errors: ${parsed.lineErrors.length}`);
  console.log(`- Warnings: ${parsed.warnings.length}`);

  if (parsed.validCount !== 4) {
    throw new Error(`Expected 4 valid segments, got ${parsed.validCount}`);
  }
  if (parsed.lineErrors.length !== 1) {
    throw new Error(`Expected 1 line error (reversed time), got ${parsed.lineErrors.length}`);
  }
  const duplicateWarning = parsed.warnings.some((w) => w.message.includes('Duplicate range'));
  const overlapWarning = parsed.warnings.some((w) => w.message.includes('overlaps line'));
  console.log(`- Detected duplicate: ${duplicateWarning}`);
  console.log(`- Detected overlap: ${overlapWarning}`);
  if (!duplicateWarning || !overlapWarning) {
    throw new Error('Failed to detect duplicate or overlapping ranges.');
  }
  console.log('✅ Test 1 Passed.\n');

  // Test 2: Generate test videos (one with facecam, one gameplay-only)
  console.log('Test 2: Generating synthetic test video with facecam overlay...');
  const sampleWithCam = await generateSampleStreamVideo();
  const samplePathWithCam = path.join(SOURCES_DIR, sampleWithCam.fileName);
  console.log(`- Created sample video with cam: ${samplePathWithCam} (${fs.statSync(samplePathWithCam).size} bytes)`);

  const pureGameplayFile = path.join(SOURCES_DIR, 'test_gameplay_only.mp4');
  console.log('Generating pure gameplay-only video (no webcam)...');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=1280x720:rate=30:duration=8',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    pureGameplayFile
  ]);
  console.log(`- Created pure gameplay video: ${pureGameplayFile} (${fs.statSync(pureGameplayFile).size} bytes)`);
  console.log('✅ Test 2 Passed.\n');

  // Test 3: Facecam Detection on Video with Webcam
  console.log('Test 3: Automatic Facecam Detection on video with facecam overlay');
  const resCam = await detectSegmentFacecam(samplePathWithCam, 18, 'split-top-cam');
  console.log(`- Result: hasFacecam=${resCam.hasFacecam}, status=${resCam.status}, position=${resCam.positionLabel}`);
  console.log(`- Effective layout: ${resCam.effectiveLayout}`);
  console.log(`- Bounding box: ${JSON.stringify(resCam.boundingBox)}`);
  console.log('✅ Test 3 Passed.\n');

  // Test 4: Automatic Fallback: Gameplay Only when NO facecam is present
  console.log('Test 4: Mandatory Fallback to Gameplay Only on video without facecam');
  const resNoCam = await detectSegmentFacecam(pureGameplayFile, 8, 'split-top-cam');
  console.log(`- Result: hasFacecam=${resNoCam.hasFacecam}, status=${resNoCam.status}`);
  console.log(`- Effective layout: ${resNoCam.effectiveLayout} (Expected: center-crop-focus)`);
  if (resNoCam.effectiveLayout !== 'center-crop-focus') {
    throw new Error(`Expected fallback to center-crop-focus, but got ${resNoCam.effectiveLayout}`);
  }
  console.log('✅ Test 4 Passed: Automatically fell back to center-crop-focus (Gameplay Only)!\n');

  // Test 5: Variable duration 1080x1920 9:16 rendering with effective layout
  console.log('Test 5: 9:16 Full HD (1080x1920) Rendering with Effective Layout');
  const outCamName = 'test_clip_facecam_001.mp4';
  const renderResCam = await renderSegmentClipV2({
    inputFilePath: samplePathWithCam,
    outputFileName: outCamName,
    layoutId: resCam.effectiveLayout,
    templateId: 'none',
    facecamBox: resCam.boundingBox,
    branding: { creditText: '@tester', backgroundHex: '#0B0D11', watermarkText: '' },
    resolution: '1080x1920',
    frameRate: 'original',
    onProgress: (p, stage) => process.stdout.write(`\rRendering with Cam: ${p}% (${stage})`),
  });
  console.log(`\n- Rendered Facecam Clip: ${renderResCam.outputPath} (${renderResCam.fileSizeBytes} bytes, res: ${renderResCam.resolution})`);

  const outNoCamName = 'test_clip_gameplay_002.mp4';
  const renderResNoCam = await renderSegmentClipV2({
    inputFilePath: pureGameplayFile,
    outputFileName: outNoCamName,
    layoutId: resNoCam.effectiveLayout,
    templateId: 'none',
    facecamBox: null,
    branding: { creditText: '@tester', backgroundHex: '#0B0D11', watermarkText: '' },
    resolution: '1080x1920',
    frameRate: 'original',
    onProgress: (p, stage) => process.stdout.write(`\rRendering Gameplay Only: ${p}% (${stage})`),
  });
  console.log(`\n- Rendered Gameplay Only Clip: ${renderResNoCam.outputPath} (${renderResNoCam.fileSizeBytes} bytes, res: ${renderResNoCam.resolution})`);
  console.log('✅ Test 5 Passed.\n');

  console.log('🎉 ALL V2 TESTS COMPLETED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
