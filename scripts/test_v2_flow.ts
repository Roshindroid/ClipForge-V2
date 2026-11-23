import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseMultilineTimestamps } from '../src/lib/timestampParser.ts';
import type { ClipProject, LayoutId, ProjectSegment } from '../src/types.ts';
import { extractSegmentFrameAtFraction, generateSampleStreamVideo, probeMediaFile } from '../server/ingest.ts';
import { startSegmentRenders } from '../server/projectRunner.ts';
import {
  clampFacecamBox,
  renderLayoutPreviewFrame,
  renderSegmentClipV2,
  verifyRenderedOutput,
} from '../server/rendererV2.ts';
import {
  FRAMES_DIR,
  SOURCES_DIR,
  deleteClip,
  deleteProject,
  ensureWorkspace,
  getClip,
  getProject,
  listClips,
  resolveSafeChildPath,
  resolveSafeSourcePath,
  restoreWorkspaceOnBoot,
  saveProject,
} from '../server/storage.ts';

const execFileAsync = promisify(execFile);

async function runTests() {
  console.log('=== ClipForge Manual Workflow & Persistence Verification Suite ===\n');
  ensureWorkspace();

  const createdProjectIds: string[] = [];
  const tempRenderFiles: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // Test 1: Timestamp Parsing & Validation
    // -------------------------------------------------------------------------
    console.log('Test 1: Multiline Timestamp Parsing, Bounds & Warnings');
    const tsInput = [
      '00:01:00 - 00:01:45 Opening Highlight',
      '00:02:10 - 00:03:00 Epic clutch',
      '00:02:50 - 00:03:30 Overlapping segment',
      '00:01:00 - 00:01:45 Duplicate line',
      '00:10:00 - 00:08:00 Reversed time',
      '01:05:00 - 01:06:00 Beyond 1h video',
    ].join('\n');

    const parsed = parseMultilineTimestamps(tsInput, 3600);
    if (parsed.validCount !== 4) {
      throw new Error(`Expected 4 valid segments, got ${parsed.validCount}`);
    }
    if (parsed.lineErrors.length !== 2) {
      throw new Error(`Expected 2 line errors (reversed + beyond duration), got ${parsed.lineErrors.length}`);
    }
    if (!parsed.warnings.some((w) => w.message.includes('Duplicate range'))) {
      throw new Error('Expected duplicate range warning.');
    }
    if (!parsed.warnings.some((w) => w.message.includes('overlaps line'))) {
      throw new Error('Expected overlap warning.');
    }
    console.log('✅ Test 1 Passed.\n');

    // -------------------------------------------------------------------------
    // Test 2: Edge Facecam Clamping (no 0.85 hard cap)
    // -------------------------------------------------------------------------
    console.log('Test 2: Manual Facecam Coordinate Clamping');
    const edgeBox = clampFacecamBox({ x: 0.88, y: 0.02, width: 0.12, height: 0.22 });
    if (Math.abs(edgeBox.x - 0.88) > 0.001 || Math.abs(edgeBox.width - 0.12) > 0.001) {
      throw new Error(`Edge box was distorted: ${JSON.stringify(edgeBox)}`);
    }
    const overflowBox = clampFacecamBox({ x: 0.95, y: 0.95, width: 0.2, height: 0.2 });
    if (overflowBox.x + overflowBox.width > 1.0001 || overflowBox.y + overflowBox.height > 1.0001) {
      throw new Error(`Overflow box exceeded 1.0 boundary: ${JSON.stringify(overflowBox)}`);
    }
    console.log('✅ Test 2 Passed.\n');

    // -------------------------------------------------------------------------
    // Test 3: Synthetic Source + Validation + 7 Layouts at 1080x1920 + Preview
    // -------------------------------------------------------------------------
    console.log('Test 3: Synthetic Video, Manual Facecam Validation & 7 Layouts (1080x1920)');
    const sample = await generateSampleStreamVideo();
    const samplePath = resolveSafeChildPath(SOURCES_DIR, sample.fileName);
    const probed = await probeMediaFile(samplePath);

    // 3a. Must reject facecam-dependent layout when facecamBox is null
    let rejectedMissingCam = false;
    try {
      await renderSegmentClipV2({
        inputFilePath: samplePath,
        outputFileName: 'should_fail_no_cam.mp4',
        layoutId: 'split-top-cam',
        templateId: 'none',
        facecamBox: null,
        branding: { creditText: '@tester', backgroundHex: '#0B0D11', watermarkText: '' },
        resolution: '1080x1920',
        frameRate: 'original',
      });
    } catch {
      rejectedMissingCam = true;
    }
    if (!rejectedMissingCam) {
      throw new Error('Expected renderSegmentClipV2 to reject split-top-cam without a facecam box.');
    }

    // 3b. Render all key layouts at 1080x1920 and verify via ffprobe
    const manualBox = { x: 0.73, y: 0.67, width: 0.25, height: 0.29 };
    const layoutsToVerify: LayoutId[] = [
      'split-top-cam',
      'split-bottom-cam',
      'split-50-50',
      'pip-top-left',
      'blurred-bg-cam-top',
      'center-crop-focus',
      'facecam-only-zoom',
    ];

    for (const layoutId of layoutsToVerify) {
      const outName = `test_layout_${layoutId}_${crypto.randomBytes(2).toString('hex')}.mp4`;
      tempRenderFiles.push(outName);
      const res = await renderSegmentClipV2({
        inputFilePath: samplePath,
        outputFileName: outName,
        layoutId,
        templateId: layoutId === 'split-top-cam' ? 'tiktok-hook' : 'none',
        hookTagline: 'Manual Test Hook',
        facecamBox: layoutId === 'center-crop-focus' ? null : manualBox,
        branding: { creditText: '@tester', backgroundHex: '#0B0D11', watermarkText: 'ClipForge' },
        resolution: '1080x1920',
        frameRate: 'original',
      });
      await verifyRenderedOutput(res.outputPath, 1080, 1920, probed.hasAudio);
      console.log(`  - Verified ${layoutId}: ${res.resolution}, ${res.fileSizeBytes} bytes, ${res.durationSec}s`);
    }

    // 3c. Verify FFmpeg 9:16 single-frame composite preview
    const previewFrameUrl = await extractSegmentFrameAtFraction({
      projectId: 'test_proj',
      segmentId: 'test_seg',
      segmentFilePath: samplePath,
      durationSec: probed.durationSec,
      fraction: 0.5,
    });
    const previewFramePath = resolveSafeChildPath(
      FRAMES_DIR,
      previewFrameUrl.replace('/api/frames/', '')
    );
    const previewBuf = await renderLayoutPreviewFrame({
      inputImagePath: previewFramePath,
      layoutId: 'split-top-cam',
      templateId: 'x-post',
      facecamBox: manualBox,
      branding: { creditText: '@tester', backgroundHex: '#0B0D11', watermarkText: '' },
      hookTagline: 'Preview Test',
    });
    if (previewBuf.length < 2000) {
      throw new Error('FFmpeg preview frame JPEG too small.');
    }
    console.log(`  - Verified FFmpeg 9:16 single-frame preview (${previewBuf.length} bytes JPEG)`);
    if (fs.existsSync(previewFramePath)) fs.unlinkSync(previewFramePath);
    console.log('✅ Test 3 Passed.\n');

    // -------------------------------------------------------------------------
    // Test 4: 5-Segment Batch with Per-Segment Facecam Override & Persistence
    // -------------------------------------------------------------------------
    console.log('Test 4: 5-Segment Batch Render + Per-Segment Override + Restart Persistence');
    const projectId = `proj_test_${crypto.randomBytes(4).toString('hex')}`;
    createdProjectIds.push(projectId);
    const projSourceDir = resolveSafeSourcePath(projectId);
    fs.mkdirSync(projSourceDir, { recursive: true });

    const segments: ProjectSegment[] = [];
    for (let i = 0; i < 5; i++) {
      const segId = `seg_${i + 1}`;
      const start = i * 3;
      const dur = 3;
      const relFile = `${projectId}/segment_${String(i + 1).padStart(3, '0')}_${segId}.mp4`;
      const destPath = resolveSafeSourcePath(relFile);
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        String(start),
        '-t',
        String(dur),
        '-i',
        samplePath,
        '-c',
        'copy',
        destPath,
      ]);
      const frameUrl = await extractSegmentFrameAtFraction({
        projectId,
        segmentId: segId,
        segmentFilePath: destPath,
        durationSec: dur,
        fraction: 0.5,
      });

      const isOverride = i === 2;
      segments.push({
        id: segId,
        order: i + 1,
        startSeconds: start,
        endSeconds: start + dur,
        durationSeconds: dur,
        title: `Test Segment #${i + 1}`,
        hookTagline: `Hook #${i + 1}`,
        downloadStatus: 'ready',
        downloadProgress: 100,
        sourceFileName: relFile,
        sourceSizeBytes: fs.statSync(destPath).size,
        frameUrl,
        width: probed.width,
        height: probed.height,
        fps: probed.fps,
        hasAudio: probed.hasAudio,
        facecamBox: isOverride ? { x: 0.05, y: 0.05, width: 0.25, height: 0.3 } : null,
        hasCustomFacecam: isOverride,
        layoutId: 'split-top-cam',
        hasCustomLayout: false,
        renderStatus: 'idle',
        renderProgress: 0,
      });
    }

    // Remove temporary full sample video
    if (fs.existsSync(samplePath)) fs.unlinkSync(samplePath);

    const project: ClipProject = {
      id: projectId,
      title: 'Test 5-Segment Persistence Project',
      sourceType: 'local',
      sourceUrl: 'sample://test',
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      fps: probed.fps,
      hasAudio: probed.hasAudio,
      sharedFacecamBox: manualBox,
      sharedLayoutId: 'split-top-cam',
      templateId: 'none',
      resolution: '720x1280',
      frameRate: 'original',
      branding: { creditText: '@tester', backgroundHex: '#0B0D11', watermarkText: '' },
      segments,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveProject(project);

    const { queuedCount } = startSegmentRenders(projectId);
    if (queuedCount !== 5) {
      throw new Error(`Expected 5 queued renders, got ${queuedCount}`);
    }

    // Wait for all 5 background renders to complete
    const deadline = Date.now() + 90_000;
    let finishedProj: ClipProject | undefined;
    while (Date.now() < deadline) {
      const p = getProject(projectId);
      if (
        p &&
        p.segments.every(
          (s) => s.renderStatus === 'completed' || s.renderStatus === 'failed'
        )
      ) {
        finishedProj = p;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!finishedProj) {
      throw new Error('Timed out waiting for 5-segment batch render.');
    }

    for (const s of finishedProj.segments) {
      if (s.renderStatus !== 'completed' || !s.renderedClipId) {
        throw new Error(`Segment ${s.order} did not complete: ${s.renderStatus} (${s.renderError})`);
      }
    }

    // Verify per-segment override was preserved on the rendered clip
    const seg3ClipId = finishedProj.segments[2].renderedClipId!;
    const seg3Clip = getClip(seg3ClipId);
    if (!seg3Clip || Math.abs((seg3Clip.facecamBox?.x ?? 0) - 0.05) > 0.005) {
      throw new Error('Segment #3 custom facecam override was not preserved on rendered clip.');
    }

    // Simulate server restart and verify clips + project survive
    restoreWorkspaceOnBoot();
    const restoredProj = getProject(projectId);
    if (!restoredProj || restoredProj.segments.length !== 5) {
      throw new Error('Project did not survive restoreWorkspaceOnBoot().');
    }
    const allClipsAfterBoot = listClips();
    for (const s of restoredProj.segments) {
      if (!allClipsAfterBoot.some((c) => c.id === s.renderedClipId)) {
        throw new Error(`Clip ${s.renderedClipId} missing after restoreWorkspaceOnBoot().`);
      }
    }

    // Verify explicit single clip deletion keeps source segment & other clips intact
    const clipToDelete = restoredProj.segments[0].renderedClipId!;
    const deleted = deleteClip(clipToDelete);
    if (!deleted || getClip(clipToDelete)) {
      throw new Error('Explicit single clip deletion failed.');
    }
    const afterClipDeleteProj = getProject(projectId);
    if (
      !afterClipDeleteProj ||
      afterClipDeleteProj.segments[0].downloadStatus !== 'ready' ||
      afterClipDeleteProj.segments[0].renderedClipId !== undefined
    ) {
      throw new Error('Deleting single clip corrupted segment source or failed to clear clip link.');
    }

    console.log('✅ Test 4 Passed.\n');
    console.log('🎉 ALL CLIPFORGE MANUAL WORKFLOW TESTS PASSED!');
  } finally {
    // Cleanup synthetic test artifacts so workspace stays clean
    for (const pid of createdProjectIds) {
      deleteProject(pid, { deleteClips: true });
    }
    const { RENDERS_DIR } = await import('../server/storage.ts');
    for (const f of tempRenderFiles) {
      try {
        const p = resolveSafeChildPath(RENDERS_DIR, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
