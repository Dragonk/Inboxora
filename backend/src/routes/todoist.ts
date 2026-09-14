import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { sessionUserId } from '../utils/query.js';
import { toAppError } from '../utils/errors.js';
import type { Request, Response } from 'express';

interface TodoistListResponse { results?: unknown[] }
interface TodoistTask { id?: string; content?: string }
interface TodoistErrorResponse { error?: string }
interface TodoistTaskInput {
  content: string;
  description?: string;
  project_id?: string;
  labels?: unknown[];
  priority?: number;
  due_string?: string;
  due_date?: string;
}

const router = Router();
router.use(requireAuth);

async function getTodoistToken(userId: string) {
  const result = await query(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
    [userId]
  );
  if (!result.rows.length) {
    throw Object.assign(new Error('Todoist not connected'), { status: 409 });
  }
  return decrypt(result.rows[0].config.token);
}

async function todoistFetch<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const opts: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.todoist.com/api/v1${path}`, opts);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as TodoistErrorResponse;
    throw Object.assign(new Error(err.error || `Todoist API error ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

// GET /api/todoist/status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const result = await query<{ id: string }>(
      "SELECT id FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
      [req.session.userId]
    );
    res.json({ connected: result.rows.length > 0 });
  } catch (caught) {
    const err = toAppError(caught);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/todoist/connect
router.post('/connect', async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'API token is required' });
  }
  const trimmed = token.trim();

  try {
    // Validate token against Todoist before storing
    const testRes = await fetch('https://api.todoist.com/api/v1/projects', {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    // Drain body to allow connection reuse
    await testRes.body?.cancel();
    if (!testRes.ok) {
      return res.status(400).json({ error: 'Invalid Todoist API token' });
    }

    const encryptedToken = encrypt(trimmed);
    await query(`
      INSERT INTO user_integrations (user_id, provider, config)
      VALUES ($1, 'todoist', $2)
      ON CONFLICT (user_id, provider) DO UPDATE
      SET config = EXCLUDED.config, updated_at = NOW()
    `, [req.session.userId, { token: encryptedToken }]);

    res.json({ ok: true });
  } catch (caught) {
    const err = toAppError(caught);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/todoist/disconnect
router.delete('/disconnect', async (req: Request, res: Response) => {
  try {
    await query(
      "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (caught) {
    const err = toAppError(caught);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/todoist/projects
router.get('/projects', async (req: Request, res: Response) => {
  try {
    const token = await getTodoistToken(sessionUserId(req));
    const data = await todoistFetch<TodoistListResponse>(token, 'GET', '/projects');
    res.json(data.results ?? data);
  } catch (caught) {
    const err = toAppError(caught);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/todoist/labels
router.get('/labels', async (req: Request, res: Response) => {
  try {
    const token = await getTodoistToken(sessionUserId(req));
    const data = await todoistFetch<TodoistListResponse>(token, 'GET', '/labels');
    res.json(data.results ?? data);
  } catch (caught) {
    const err = toAppError(caught);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/todoist/tasks
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const token = await getTodoistToken(sessionUserId(req));
    const { content, description, project_id, labels, priority, due_string, due_date } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }
    const taskData: TodoistTaskInput = { content: content.trim() };
    if (description) taskData.description = description;
    if (project_id) taskData.project_id = project_id;
    if (labels?.length) taskData.labels = labels;
    if (priority && priority > 1) taskData.priority = priority;
    if (due_string) taskData.due_string = due_string;
    if (due_date) taskData.due_date = due_date;
    const task = await todoistFetch<TodoistTask>(token, 'POST', '/tasks', taskData);
    res.json({ ...task, url: `https://app.todoist.com/app/task/${task.id}` });
  } catch (caught) {
    const err = toAppError(caught);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
