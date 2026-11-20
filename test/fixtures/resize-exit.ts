import { makeService } from '../fakes.ts';
const env = makeService();
const { task } = await env.service.launchTask({ title: 'Resize', role: 'implement', brief: 'Resize', repo: 'acme/web', orchestratorThreadId: 'thr_orch', projectId: 'proj_personal' }, 5_000);
env.boat.finish(task.conversationId!, 'Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===');
await env.service.sweep();
await env.service.sizes.settled();
await env.service.sizes.resize({ taskId: task.id, type: 'large', message: null, userApproved: true, notifyThreadId: null, waitMs: 600_000, by: 'page' });
