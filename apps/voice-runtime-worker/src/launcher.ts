import { env } from "./config.js";
import {
  appendCallEvent,
  claimRuntimeLaunchJobs,
  markRuntimeLaunchJobFailed,
  markRuntimeLaunchJobSucceeded
} from "./db.js";
import { requestAgentSessionLaunch } from "./services/agent-launcher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAgentSessionLauncherLoop(): Promise<void> {
  while (true) {
    const jobs = await claimRuntimeLaunchJobs(env.WORKER_BATCH_SIZE, env.WORKER_MAX_ATTEMPTS);
    if (jobs.length === 0) {
      await sleep(env.LAUNCHER_POLL_INTERVAL_MS);
      continue;
    }

    for (const job of jobs) {
      try {
        await requestAgentSessionLaunch({
          callId: job.call_id,
          tenantId: job.tenant_id,
          agentId: job.agent_id,
          traceId: job.trace_id,
          room: job.room,
          twilioCallSid: job.twilio_call_sid,
          livekitUrl: job.livekit_url,
          agentJoinToken: job.agent_join_token
        });

        await markRuntimeLaunchJobSucceeded(job.id);
        await appendCallEvent(job.call_id, "runtime.agent_session_launch_succeeded", {
          launch_job_id: job.id,
          trace_id: job.trace_id,
          room: job.room,
          attempts: job.attempts
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "agent_session_launch_error";
        await markRuntimeLaunchJobFailed(job.id, message);
        const willRetry = job.attempts < env.WORKER_MAX_ATTEMPTS;

        await appendCallEvent(job.call_id, "runtime.agent_session_launch_failed", {
          launch_job_id: job.id,
          trace_id: job.trace_id,
          room: job.room,
          attempts: job.attempts,
          will_retry: willRetry,
          error: message
        });
      }
    }
  }
}
