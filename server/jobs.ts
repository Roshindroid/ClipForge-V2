import crypto from 'node:crypto';
import type { JobStatus, RenderedClip, VideoProject } from '../src/types.ts';

const jobs = new Map<string, JobStatus>();
const renderCycles = new Map<string, { hadFailure: boolean }>();
const JOB_TTL_MS = 60 * 60 * 1000;

let renderQueueTail: Promise<void> = Promise.resolve();

function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (
      (job.status === 'completed' || job.status === 'failed') &&
      new Date(job.updatedAt).getTime() < cutoff
    ) {
      jobs.delete(id);
    }
  }
}

export function hasPendingRenderJobs(projectId: string, excludeJobId?: string): boolean {
  for (const job of jobs.values()) {
    if (
      job.type === 'render' &&
      job.projectId === projectId &&
      job.id !== excludeJobId &&
      (job.status === 'queued' || job.status === 'running')
    ) {
      return true;
    }
  }
  return false;
}

export function createJob(
  type: JobStatus['type'],
  stage: string,
  detail?: string,
  options?: {
    status?: 'queued' | 'running';
    projectId?: string;
    momentId?: string;
  }
): JobStatus {
  pruneOldJobs();
  const now = new Date().toISOString();
  const projectId = options?.projectId;

  if (type === 'render' && projectId && !hasPendingRenderJobs(projectId)) {
    renderCycles.set(projectId, { hadFailure: false });
  }

  const job: JobStatus = {
    id: `job_${crypto.randomBytes(6).toString('hex')}`,
    type,
    status: options?.status || 'running',
    progress: options?.status === 'queued' ? 0 : 2,
    stage,
    detail,
    projectId,
    momentId: options?.momentId,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(
  id: string,
  patch: Partial<Pick<JobStatus, 'status' | 'progress' | 'stage' | 'detail'>>
): void {
  const job = jobs.get(id);
  if (!job) return;
  if (patch.status === 'queued' || patch.status === 'running') {
    job.status = patch.status;
  }
  if (typeof patch.progress === 'number') {
    job.progress = Math.max(0, Math.min(99, Math.round(patch.progress)));
  }
  if (patch.stage !== undefined) job.stage = patch.stage;
  if (patch.detail !== undefined) job.detail = patch.detail;
  job.updatedAt = new Date().toISOString();
}

export function canAutoPruneProject(projectId: string, completingJobId: string): boolean {
  if (hasPendingRenderJobs(projectId, completingJobId)) {
    return false;
  }
  const cycle = renderCycles.get(projectId);
  return !cycle?.hadFailure;
}

export function completeJob(
  id: string,
  result: { project?: VideoProject; clip?: RenderedClip; autoPruned?: boolean }
): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'completed';
  job.progress = 100;
  job.stage = result.autoPruned ? 'Completed (Source VOD Auto-Pruned)' : 'Completed';
  job.project = result.project;
  job.clip = result.clip;
  if (typeof result.autoPruned === 'boolean') {
    job.autoPruned = result.autoPruned;
  }
  job.updatedAt = new Date().toISOString();
}

export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'failed';
  job.stage = 'Failed';
  job.error = error;
  if (job.type === 'render' && job.projectId) {
    renderCycles.set(job.projectId, { hadFailure: true });
  }
  job.updatedAt = new Date().toISOString();
}

export function getJob(id: string): JobStatus | undefined {
  return jobs.get(id);
}

export function enqueueRenderTask(task: () => Promise<void>): void {
  renderQueueTail = renderQueueTail.then(task, task);
}
